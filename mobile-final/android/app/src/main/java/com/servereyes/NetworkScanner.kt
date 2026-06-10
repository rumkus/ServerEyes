package com.servereyes

import com.facebook.react.bridge.*
import java.io.BufferedReader
import java.io.FileReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NetworkScanner(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "NetworkScanner"

    private fun getArpTable(): Map<String, String> {
        val arpMap = mutableMapOf<String, String>()
        try {
            val reader = BufferedReader(FileReader("/proc/net/arp"))
            reader.readLine() // skip header
            var line = reader.readLine()
            while (line != null) {
                val parts = line.split("\\s+".toRegex())
                if (parts.size >= 4) {
                    val ip = parts[0]
                    val mac = parts[3].uppercase()
                    if (mac != "00:00:00:00:00:00" && mac.length == 17) {
                        arpMap[ip] = mac
                    }
                }
                line = reader.readLine()
            }
            reader.close()
        } catch (_: Exception) {}
        return arpMap
    }

    @ReactMethod
    fun scanSubnet(subnet: String, promise: Promise) {
        Thread {
            try {
                val results = WritableNativeArray()
                val executor = Executors.newFixedThreadPool(30)
                val found = AtomicInteger(0)
                val futures = mutableListOf<java.util.concurrent.Future<*>>()
                // Read ARP table after pings populate it
                val arpTable = mutableMapOf<String, String>()

                for (i in 1..254) {
                    val ip = "$subnet$i"
                    futures.add(executor.submit {
                        try {
                            val addr = InetAddress.getByName(ip)
                            // Try ICMP ping first (fastest)
                            if (addr.isReachable(400)) {
                                val device = WritableNativeMap()
                                device.putString("ip", ip)
                                device.putString("hostname", addr.canonicalHostName ?: "")
                                device.putString("status", "up")

                                // Scan common ports
                                val ports = intArrayOf(21, 22, 23, 53, 80, 135, 139, 443, 445, 631, 3306, 3389, 5353, 5900, 8080, 9100)
                                val openPorts = WritableNativeArray()
                                for (port in ports) {
                                    try {
                                        val socket = Socket()
                                        socket.connect(InetSocketAddress(ip, port), 300)
                                        socket.close()
                                        openPorts.pushInt(port)
                                    } catch (_: Exception) {}
                                }
                                device.putArray("ports", openPorts)

                                // Detect device type
                                val portList = mutableListOf<Int>()
                                for (j in 0 until openPorts.size()) {
                                    portList.add(openPorts.getInt(j))
                                }
                                val type = when {
                                    portList.contains(9100) || portList.contains(631) || portList.contains(515) -> "🖨 Impresora"
                                    portList.contains(80) && portList.contains(443) && !portList.contains(3389) && !portList.contains(22) -> "🌐 Router/AP"
                                    portList.contains(3389) -> "💻 PC Windows"
                                    portList.contains(22) -> "🖥 Servidor Linux"
                                    portList.contains(445) || portList.contains(139) -> "💻 PC Windows"
                                    portList.contains(23) -> "🔀 Switch/Router"
                                    portList.contains(5900) -> "🖥 PC (VNC)"
                                    portList.contains(3306) || portList.contains(5432) -> "🗄 Servidor DB"
                                    portList.contains(53) || portList.contains(5353) -> "📱 Movil/IoT"
                                    portList.contains(80) || portList.contains(443) || portList.contains(8080) -> "📡 Dispositivo Web"
                                    else -> "📡 Dispositivo"
                                }
                                device.putString("type", type)
                                device.putString("mac", "")

                                synchronized(results) {
                                    results.pushMap(device)
                                }
                                found.incrementAndGet()
                            }
                        } catch (_: Exception) {}
                    })
                }

                executor.shutdown()
                executor.awaitTermination(120, TimeUnit.SECONDS)

                // Read ARP table to get MAC addresses
                val arp = getArpTable()
                val finalResults = WritableNativeArray()
                for (i in 0 until results.size()) {
                    val device = results.getMap(i)
                    if (device != null) {
                        val updated = WritableNativeMap()
                        updated.putString("ip", device.getString("ip") ?: "")
                        updated.putString("hostname", device.getString("hostname") ?: "")
                        updated.putString("status", device.getString("status") ?: "up")
                        updated.putString("type", device.getString("type") ?: "")
                        updated.putArray("ports", device.getArray("ports") ?: WritableNativeArray())
                        updated.putString("mac", arp[device.getString("ip")] ?: "")
                        finalResults.pushMap(updated)
                    }
                }

                promise.resolve(finalResults)
            } catch (e: Exception) {
                promise.reject("SCAN_ERROR", e.message)
            }
        }.start()
    }
}
