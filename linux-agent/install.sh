#!/bin/bash
# ServerEyes Linux Agent - Instalador
# Uso: curl -sSL https://servereyes.app/linux-install.sh | bash

set -e

INSTALL_DIR="${1:-/opt/servereyes}"
CONFIG_FILE="$INSTALL_DIR/config.json"
LOG_FILE="$INSTALL_DIR/agent.log"
SERVICE_NAME="servereyes-agent"
AGENT_VERSION="1.0.0"
DEFAULT_SERVER="https://servereyes.app"

echo ""
echo "========================================="
echo "   ServerEyes Linux Agent - Instalacion"
echo "========================================="
echo ""

# Verificar root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Ejecutar como root (sudo)"
  exit 1
fi

# Crear directorio
mkdir -p "$INSTALL_DIR"
echo "Directorio: $INSTALL_DIR"

# Pedir configuracion si no existe
if [ ! -f "$CONFIG_FILE" ]; then
  read -p "URL del servidor [$DEFAULT_SERVER]: " SERVER_URL
  SERVER_URL="${SERVER_URL:-$DEFAULT_SERVER}"

  read -p "Nombre de esta maquina [$(hostname)]: " MACHINE_NAME
  MACHINE_NAME="${MACHINE_NAME:-$(hostname)}"

  read -p "Clave de maquina: " MACHINE_KEY
  if [ -z "$MACHINE_KEY" ]; then
    echo "Error: La clave de maquina es requerida"
    exit 1
  fi

  cat > "$CONFIG_FILE" << CONF
{
  "serverUrl": "$SERVER_URL",
  "machineKey": "$MACHINE_KEY",
  "machineName": "$MACHINE_NAME",
  "heartbeatInterval": 30
}
CONF
  echo "Configuracion guardada en $CONFIG_FILE"
fi

# Crear el agente
cat > "$INSTALL_DIR/agent.sh" << 'AGENT'
#!/bin/bash
# ServerEyes Linux Agent

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
LOG_FILE="$SCRIPT_DIR/agent.log"
AGENT_VERSION="1.0.0"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Leer config
if [ ! -f "$CONFIG_FILE" ]; then
  log "ERROR: No se encontro $CONFIG_FILE"
  exit 1
fi

SERVER_URL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['serverUrl'])" 2>/dev/null || echo "")
MACHINE_KEY=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['machineKey'])" 2>/dev/null || echo "")
MACHINE_NAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['machineName'])" 2>/dev/null || hostname)
HEARTBEAT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('heartbeatInterval', 30))" 2>/dev/null || echo "30")

if [ -z "$SERVER_URL" ] || [ -z "$MACHINE_KEY" ]; then
  log "ERROR: serverUrl y machineKey son requeridos en config.json"
  exit 1
fi

get_cpu() {
  top -bn1 | grep "Cpu(s)" | awk '{print int($2 + $4)}' 2>/dev/null || echo "0"
}

get_ram() {
  free -m | awk '/Mem:/ {printf "%.1f %.1f", $3/1024, $2/1024}'
}

get_disks() {
  local disks="["
  local first=true
  while IFS= read -r line; do
    local dev=$(echo "$line" | awk '{print $1}')
    local total_kb=$(echo "$line" | awk '{print $2}')
    local used_kb=$(echo "$line" | awk '{print $3}')
    local free_kb=$(echo "$line" | awk '{print $4}')
    local mount=$(echo "$line" | awk '{print $6}')
    local total=$(echo "scale=1; $total_kb/1048576" | bc)
    local used=$(echo "scale=1; $used_kb/1048576" | bc)
    local free_gb=$(echo "scale=1; $free_kb/1048576" | bc)
    if [ "$first" = true ]; then first=false; else disks+=","; fi
    disks+="{\"drive\":\"$mount\",\"total\":$total,\"used\":$used,\"free\":$free_gb}"
  done < <(df -k --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2)
  disks+="]"
  echo "$disks"
}

get_local_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

get_public_ip() {
  curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo ""
}

get_ping() {
  ping -c 1 -W 2 8.8.8.8 2>/dev/null | grep "time=" | awk -F'time=' '{print int($2)}' || echo ""
}

get_os_info() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$PRETTY_NAME $(uname -r)"
  else
    uname -a
  fi
}

get_services() {
  local svcs="["
  local first=true
  while IFS= read -r line; do
    local name=$(echo "$line" | awk '{print $1}')
    local state=$(echo "$line" | awk '{print $4}')
    local display="$name"
    local st="STOPPED"
    if [ "$state" = "running" ]; then st="RUNNING"; fi
    if [ "$first" = true ]; then first=false; else svcs+=","; fi
    svcs+="{\"name\":\"$name\",\"display\":\"$display\",\"state\":\"$st\"}"
  done < <(systemctl list-units --type=service --all --no-pager --plain 2>/dev/null | grep "\.service" | head -50 | awk '{gsub(/\.service/,"",$1); sub(/●/,"",$1); print $1, $2, $3, $4}')
  svcs+="]"
  echo "$svcs"
}

get_open_ports() {
  local ports="["
  local first=true
  while IFS= read -r port; do
    if [ -n "$port" ]; then
      if [ "$first" = true ]; then first=false; else ports+=","; fi
      ports+="$port"
    fi
  done < <(ss -tlnp 2>/dev/null | awk 'NR>1 {split($4,a,":"); print a[length(a)]}' | sort -un | head -20)
  ports+="]"
  echo "$ports"
}

get_last_logs() {
  tail -n 30 "$LOG_FILE" 2>/dev/null || echo ""
}

get_speed() {
  if command -v speedtest-cli &>/dev/null; then
    speedtest-cli --simple 2>/dev/null | grep "Download" | awk '{printf "%.1f", $2}'
  else
    echo ""
  fi
}

log "ServerEyes Linux Agent v$AGENT_VERSION iniciado"
log "Servidor: $SERVER_URL"
log "Maquina: $MACHINE_NAME"

SPEED_COUNTER=0

while true; do
  CPU=$(get_cpu)
  RAM_INFO=$(get_ram)
  RAM_USED=$(echo "$RAM_INFO" | awk '{print $1}')
  RAM_TOTAL=$(echo "$RAM_INFO" | awk '{print $2}')
  DISKS=$(get_disks)
  LOCAL_IP=$(get_local_ip)
  PUBLIC_IP=$(get_public_ip)
  PING=$(get_ping)
  OS_INFO=$(get_os_info)
  SERVICES=$(get_services)
  PORTS=$(get_open_ports)
  LOGS=$(get_last_logs)

  # Speed test cada 10 heartbeats (~5 min)
  DOWNLOAD=""
  SPEED_COUNTER=$((SPEED_COUNTER + 1))
  if [ $SPEED_COUNTER -ge 10 ]; then
    SPEED_COUNTER=0
    DOWNLOAD=$(get_speed)
  fi

  PAYLOAD=$(cat << EOF
{
  "machine_key": "$MACHINE_KEY",
  "machine_name": "$MACHINE_NAME",
  "public_ip": "$PUBLIC_IP",
  "local_ip": "$LOCAL_IP",
  "os_info": "$OS_INFO",
  "cpu_usage": $CPU,
  "ram_usage": $RAM_USED,
  "ram_total": $RAM_TOTAL,
  "ping_ms": ${PING:-null},
  "agent_version": "$AGENT_VERSION",
  "agent_type": "linux",
  "agent_logs": $(echo "$LOGS" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '""'),
  "disks": $DISKS,
  "services": $SERVICES,
  "open_ports": $PORTS
  ${DOWNLOAD:+,"download_mbps": $DOWNLOAD}
}
EOF
)

  RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 10 -X POST "$SERVER_URL/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  if [ "$HTTP_CODE" = "200" ]; then
    log "Heartbeat OK (CPU:${CPU}% RAM:${RAM_USED}/${RAM_TOTAL}GB Ping:${PING:-?}ms)"
  else
    log "Heartbeat ERROR: HTTP $HTTP_CODE - $BODY"
  fi

  sleep "$HEARTBEAT"
done
AGENT

chmod +x "$INSTALL_DIR/agent.sh"
echo "Agente creado en $INSTALL_DIR/agent.sh"

# Crear servicio systemd
cat > "/etc/systemd/system/$SERVICE_NAME.service" << SVC
[Unit]
Description=ServerEyes Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/agent.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVC

echo "Servicio systemd creado: $SERVICE_NAME"

# Habilitar e iniciar
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo ""
echo "========================================="
echo "  Instalacion completada!"
echo "========================================="
echo ""
echo "  Directorio:  $INSTALL_DIR"
echo "  Servicio:    $SERVICE_NAME"
echo "  Config:      $CONFIG_FILE"
echo "  Logs:        $LOG_FILE"
echo ""
echo "  Comandos utiles:"
echo "    sudo systemctl status $SERVICE_NAME"
echo "    sudo systemctl restart $SERVICE_NAME"
echo "    sudo systemctl stop $SERVICE_NAME"
echo "    sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "    Para desinstalar:"
echo "    sudo systemctl stop $SERVICE_NAME"
echo "    sudo systemctl disable $SERVICE_NAME"
echo "    sudo rm /etc/systemd/system/$SERVICE_NAME.service"
echo "    sudo rm -rf $INSTALL_DIR"
echo ""
