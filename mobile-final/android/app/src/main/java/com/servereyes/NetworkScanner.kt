package com.servereyes

import com.facebook.react.bridge.*
import java.io.BufferedReader
import java.io.FileReader
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

data class ScannedDevice(
    val ip: String,
    val hostname: String,
    val ports: List<Int>,
    val type: String
)

class NetworkScanner(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "NetworkScanner"

    // ── ARP table readers (4 methods combined) ──

    private fun readArpAll(): Map<String, String> {
        val arpMap = mutableMapOf<String, String>()

        // Method 1: ip neigh via shell
        try {
            val process = Runtime.getRuntime().exec(arrayOf("/system/bin/sh", "-c", "ip neigh show 2>/dev/null"))
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            var line = reader.readLine()
            while (line != null) {
                val parts = line.split("\\s+".toRegex())
                val llIdx = parts.indexOf("lladdr")
                if (llIdx >= 0 && llIdx + 1 < parts.size) {
                    val ip = parts[0]
                    val mac = parts[llIdx + 1].uppercase()
                    if (mac != "00:00:00:00:00:00" && mac.length == 17) arpMap[ip] = mac
                }
                line = reader.readLine()
            }
            reader.close()
            process.waitFor(5, TimeUnit.SECONDS)
            process.destroyForcibly()
        } catch (_: Exception) {}

        // Method 2: /proc/net/arp direct
        try {
            val reader = BufferedReader(FileReader("/proc/net/arp"))
            reader.readLine()
            var line = reader.readLine()
            while (line != null) {
                val parts = line.split("\\s+".toRegex())
                if (parts.size >= 4) {
                    val ip = parts[0]
                    val mac = parts[3].uppercase()
                    if (mac != "00:00:00:00:00:00" && mac.length == 17 && !arpMap.containsKey(ip)) arpMap[ip] = mac
                }
                line = reader.readLine()
            }
            reader.close()
        } catch (_: Exception) {}

        // Method 3: cat /proc/net/arp via shell
        try {
            val process = Runtime.getRuntime().exec(arrayOf("/system/bin/sh", "-c", "cat /proc/net/arp 2>/dev/null"))
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            reader.readLine()
            var line = reader.readLine()
            while (line != null) {
                val parts = line.split("\\s+".toRegex())
                if (parts.size >= 4) {
                    val ip = parts[0]
                    val mac = parts[3].uppercase()
                    if (mac != "00:00:00:00:00:00" && mac.length == 17 && !arpMap.containsKey(ip)) arpMap[ip] = mac
                }
                line = reader.readLine()
            }
            reader.close()
            process.waitFor(5, TimeUnit.SECONDS)
            process.destroyForcibly()
        } catch (_: Exception) {}

        // Method 4: arp command
        try {
            val process = Runtime.getRuntime().exec(arrayOf("/system/bin/sh", "-c", "arp -a 2>/dev/null"))
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            var line = reader.readLine()
            while (line != null) {
                val ipMatch = Regex("\\((\\d+\\.\\d+\\.\\d+\\.\\d+)\\)").find(line)
                val macMatch = Regex("([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})").find(line)
                if (ipMatch != null && macMatch != null) {
                    val ip = ipMatch.groupValues[1]
                    val mac = macMatch.value.uppercase()
                    if (mac != "00:00:00:00:00:00" && !arpMap.containsKey(ip)) arpMap[ip] = mac
                }
                line = reader.readLine()
            }
            reader.close()
            process.waitFor(5, TimeUnit.SECONDS)
            process.destroyForcibly()
        } catch (_: Exception) {}

        return arpMap
    }

    // ── NetBIOS NBSTAT: gets MAC from Windows/Samba devices via UDP 137 ──

    private fun getMacViaNbstat(ip: String): String? {
        try {
            val socket = DatagramSocket()
            socket.soTimeout = 1200

            // NBSTAT request for wildcard name "*"
            val request = byteArrayOf(
                0x00, 0x01,
                0x00, 0x00,
                0x00, 0x01,
                0x00, 0x00,
                0x00, 0x00,
                0x00, 0x00,
                0x20,
                0x43, 0x4B,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
                0x00,
                0x00, 0x21,
                0x00, 0x01
            )

            val addr = InetAddress.getByName(ip)
            socket.send(DatagramPacket(request, request.size, addr, 137))

            val buffer = ByteArray(1024)
            val response = DatagramPacket(buffer, buffer.size)
            socket.receive(response)
            socket.close()

            val data = response.data
            val len = response.length
            if (len < 61) return null

            // Answer starts after header(12) + question(38) = 50
            var offset = 50

            // Skip answer name: compression pointer (0xC0xx) or full
            if (offset < len && (data[offset].toInt() and 0xC0) == 0xC0) {
                offset += 2
            } else {
                while (offset < len && data[offset].toInt() != 0) {
                    offset += (data[offset].toInt() and 0xFF) + 1
                }
                offset++
            }

            // Type(2) + Class(2) + TTL(4) + DataLength(2) = 10
            offset += 10
            if (offset >= len) return null

            val numNames = data[offset].toInt() and 0xFF
            offset += 1

            // Each name entry = 18 bytes (15 name + 1 type + 2 flags)
            offset += numNames * 18
            if (offset + 6 > len) return null

            val mac = String.format("%02X:%02X:%02X:%02X:%02X:%02X",
                data[offset].toInt() and 0xFF,
                data[offset + 1].toInt() and 0xFF,
                data[offset + 2].toInt() and 0xFF,
                data[offset + 3].toInt() and 0xFF,
                data[offset + 4].toInt() and 0xFF,
                data[offset + 5].toInt() and 0xFF
            )

            if (mac == "00:00:00:00:00:00") return null
            return mac
        } catch (_: Exception) {
            return null
        }
    }

    // ── UDP ping to force ARP table population ──

    private fun udpPingAll(ips: List<String>) {
        val executor = Executors.newFixedThreadPool(30)
        for (ip in ips) {
            executor.submit {
                try {
                    val socket = DatagramSocket()
                    socket.soTimeout = 100
                    val payload = byteArrayOf(0x00)
                    val addr = InetAddress.getByName(ip)
                    socket.send(DatagramPacket(payload, payload.size, addr, 7))
                    try { socket.receive(DatagramPacket(ByteArray(1), 1)) } catch (_: Exception) {}
                    socket.close()
                } catch (_: Exception) {}
            }
        }
        executor.shutdown()
        executor.awaitTermination(5, TimeUnit.SECONDS)
    }

    // ── Command-line ping to force ARP ──

    private fun cmdPingAll(ips: List<String>) {
        val executor = Executors.newFixedThreadPool(20)
        for (ip in ips) {
            executor.submit {
                try {
                    val p = Runtime.getRuntime().exec(arrayOf("/system/bin/sh", "-c", "ping -c 1 -W 1 $ip >/dev/null 2>&1"))
                    p.waitFor(3, TimeUnit.SECONDS)
                    p.destroyForcibly()
                } catch (_: Exception) {}
            }
        }
        executor.shutdown()
        executor.awaitTermination(15, TimeUnit.SECONDS)
    }

    // ── Main scan ──

    @ReactMethod
    fun scanSubnet(subnet: String, promise: Promise) {
        Thread {
            try {
                val deviceMap = ConcurrentHashMap<String, ScannedDevice>()
                val executor = Executors.newFixedThreadPool(30)

                // Phase 1: ICMP ping + port scan
                for (i in 1..254) {
                    val ip = "$subnet$i"
                    executor.submit {
                        try {
                            val addr = InetAddress.getByName(ip)
                            if (addr.isReachable(500)) {
                                val hostname = try { addr.canonicalHostName ?: "" } catch (_: Exception) { "" }

                                val scanPorts = intArrayOf(21, 22, 23, 53, 80, 135, 139, 443, 445, 631, 3306, 3389, 5353, 5900, 8080, 9100)
                                val openPorts = mutableListOf<Int>()
                                for (port in scanPorts) {
                                    try {
                                        val s = Socket()
                                        s.connect(InetSocketAddress(ip, port), 300)
                                        s.close()
                                        openPorts.add(port)
                                    } catch (_: Exception) {}
                                }

                                val type = when {
                                    openPorts.contains(9100) || openPorts.contains(631) || openPorts.contains(515) -> "🖨 Impresora"
                                    openPorts.contains(80) && openPorts.contains(443) && !openPorts.contains(3389) && !openPorts.contains(22) -> "🌐 Router/AP"
                                    openPorts.contains(3389) -> "💻 PC Windows"
                                    openPorts.contains(22) -> "🖥 Servidor Linux"
                                    openPorts.contains(445) || openPorts.contains(139) -> "💻 PC Windows"
                                    openPorts.contains(23) -> "🔀 Switch/Router"
                                    openPorts.contains(5900) -> "🖥 PC (VNC)"
                                    openPorts.contains(3306) || openPorts.contains(5432) -> "🗄 Servidor DB"
                                    openPorts.contains(53) || openPorts.contains(5353) -> "📱 Movil/IoT"
                                    openPorts.contains(80) || openPorts.contains(443) || openPorts.contains(8080) -> "📡 Dispositivo Web"
                                    else -> "📡 Dispositivo"
                                }

                                deviceMap[ip] = ScannedDevice(ip, hostname, openPorts, type)
                            }
                        } catch (_: Exception) {}
                    }
                }
                executor.shutdown()
                executor.awaitTermination(120, TimeUnit.SECONDS)

                val foundIps = deviceMap.keys.toList()

                // Phase 2: Force ARP population with UDP + cmd ping
                udpPingAll(foundIps)
                cmdPingAll(foundIps)
                Thread.sleep(800)

                // Phase 3: Read ARP table
                val arp = readArpAll().toMutableMap()

                // Phase 4: NetBIOS NBSTAT for IPs still missing MAC
                val missingIps = foundIps.filter { !arp.containsKey(it) }
                if (missingIps.isNotEmpty()) {
                    val nbExecutor = Executors.newFixedThreadPool(15)
                    val nbResults = ConcurrentHashMap<String, String>()
                    for (ip in missingIps) {
                        nbExecutor.submit {
                            val mac = getMacViaNbstat(ip)
                            if (mac != null) nbResults[ip] = mac
                        }
                    }
                    nbExecutor.shutdown()
                    nbExecutor.awaitTermination(30, TimeUnit.SECONDS)
                    arp.putAll(nbResults)
                }

                // Build results
                val finalResults = WritableNativeArray()
                for ((ip, device) in deviceMap) {
                    val map = WritableNativeMap()
                    map.putString("ip", device.ip)
                    map.putString("hostname", if (device.hostname != device.ip) device.hostname else "")
                    map.putString("status", "up")
                    map.putString("type", device.type)
                    map.putString("mac", arp[ip] ?: "")
                    val portsArr = WritableNativeArray()
                    for (p in device.ports) portsArr.pushInt(p)
                    map.putArray("ports", portsArr)
                    finalResults.pushMap(map)
                }

                promise.resolve(finalResults)
            } catch (e: Exception) {
                promise.reject("SCAN_ERROR", e.message)
            }
        }.start()
    }
}
