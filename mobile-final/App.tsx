import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, Alert, StatusBar, Vibration, Share, ScrollView, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import RNShare from 'react-native-share';
import messaging from '@react-native-firebase/messaging';
import { Platform, PermissionsAndroid, NativeModules } from 'react-native';
const { WidgetBridge } = NativeModules;

const API_URL = 'https://servereyes-production.up.railway.app';
const MAX_LOGS = 500;

// Sistema de logs
let _logs: string[] = [];

async function loadLogs() {
  try {
    const saved = await AsyncStorage.getItem('servereyes_logs');
    if (saved) _logs = JSON.parse(saved);
  } catch {}
}

async function saveLogs() {
  try {
    await AsyncStorage.setItem('servereyes_logs', JSON.stringify(_logs.slice(-MAX_LOGS)));
  } catch {}
}

function addLog(level: string, msg: string) {
  const ts = new Date().toLocaleString();
  const line = `[${ts}] [${level}] ${msg}`;
  _logs.push(line);
  if (_logs.length > MAX_LOGS) _logs = _logs.slice(-MAX_LOGS);
  saveLogs();
  if (__DEV__) console.log(line);
}

const log = {
  info: (msg: string) => addLog('INFO', msg),
  error: (msg: string) => addLog('ERROR', msg),
  warn: (msg: string) => addLog('WARN', msg),
};

// Capturar errores globales
const origConsoleError = console.error;
console.error = (...args: any[]) => {
  addLog('CONSOLE_ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  origConsoleError(...args);
};

async function apiRequest(path: string, options: any = {}, token: string | null = null) {
  const headers: any = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    log.info(`API ${options.method || 'GET'} ${path}`);
    const response = await fetch(`${API_URL}${path}`, { ...options, headers });
    const data = await response.json();
    if (!response.ok) log.warn(`API ${path} -> ${response.status}: ${JSON.stringify(data)}`);
    return { ok: response.ok, status: response.status, data };
  } catch (err: any) {
    log.error(`API ${path} FAILED: ${err.message}`);
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [appReady, setAppReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [machines, setMachines] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [showPairing, setShowPairing] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingStatus, setPairingStatus] = useState('');
  const [ipAlert, setIpAlert] = useState<{name: string, oldIp: string, newIp: string} | null>(null);
  const [editingMachine, setEditingMachine] = useState<any>(null);
  const [editName, setEditName] = useState('');
  const [editGrupo, setEditGrupo] = useState('');
  const [editDnsUrl, setEditDnsUrl] = useState('');
  const [editDnsHost, setEditDnsHost] = useState('');
  const [editCheckIp, setEditCheckIp] = useState(true);
  const [editNotes, setEditNotes] = useState('');
  const [editAlertCpu, setEditAlertCpu] = useState('');
  const [editAlertRam, setEditAlertRam] = useState('');
  const [editAlertDisk, setEditAlertDisk] = useState('');
  const [editAlertPing, setEditAlertPing] = useState('');
  const [editAlertOffline, setEditAlertOffline] = useState(true);
  const [dnsUpdating, setDnsUpdating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logText, setLogText] = useState('');
  const [showChangePass, setShowChangePass] = useState(false);
  const [showSmtp, setShowSmtp] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpEnabled, setSmtpEnabled] = useState(true);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [changePassError, setChangePassError] = useState('');
  const [uptimeMachine, setUptimeMachine] = useState<any>(null);
  const [uptimeData, setUptimeData] = useState<any[]>([]);
  const [uptimeDays, setUptimeDays] = useState(7);
  const [uptimeLoading, setUptimeLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'all' | 'groups'>('all');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showGroupPicker, setShowGroupPicker] = useState<any>(null);
  const [ipHistoryMachine, setIpHistoryMachine] = useState<any>(null);
  const [ipHistoryData, setIpHistoryData] = useState<any[]>([]);
  const [ipHistoryLoading, setIpHistoryLoading] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [showAgentUpdate, setShowAgentUpdate] = useState(false);
  const [detailMachine, setDetailMachine] = useState<any>(null);
  const [detailMonitored, setDetailMonitored] = useState<string[]>([]);
  const [detailAlertDisks, setDetailAlertDisks] = useState<{[key: string]: string}>({});
  const [metricsMachine, setMetricsMachine] = useState<any>(null);
  const [metricsData, setMetricsData] = useState<any[]>([]);
  const [metricsHours, setMetricsHours] = useState(24);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [agentVersion, setAgentVersion] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [showTeam, setShowTeam] = useState(false);
  const [orgData, setOrgData] = useState<any>(null);
  const [orgName, setOrgName] = useState('');
  const [orgAddress, setOrgAddress] = useState('');
  const [orgPhone, setOrgPhone] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [shareUserId, setShareUserId] = useState<number | null>(null);
  const [shareSelected, setShareSelected] = useState<Set<number>>(new Set());

  // Registrar token FCM para push notifications
  const registerFCM = async () => {
    try {
      // Pedir permiso de notificaciones (Android 13+)
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      const authStatus = await messaging().requestPermission();
      const enabled = authStatus === messaging.AuthorizationStatus.AUTHORIZED || authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (enabled) {
        const fcmToken = await messaging().getToken();
        log.info(`FCM token: ${fcmToken.slice(0, 20)}...`);
        await apiRequest('/api/fcm-token', { method: 'POST', body: JSON.stringify({ fcm_token: fcmToken }) }, tokenRef.current);
        log.info('FCM token registrado en servidor');
      } else {
        log.warn('Permiso de notificaciones denegado');
      }
    } catch (e: any) {
      log.error(`FCM error: ${e.message}`);
    }
  };

  // Listener de mensajes en primer plano
  useEffect(() => {
    const unsubscribe = messaging().onMessage(async (remoteMessage) => {
      log.info(`Push recibido: ${remoteMessage.notification?.title}`);
      if (remoteMessage.notification) {
        Alert.alert(
          remoteMessage.notification.title || 'ServerEyes',
          remoteMessage.notification.body || ''
        );
      }
    });
    return unsubscribe;
  }, []);

  // Detectar cuando la app vuelve del background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      log.info(`AppState: ${state}`);
      if (state === 'active' && tokenRef.current) {
        log.info('App volvio a primer plano, recargando...');
        setTimeout(() => loadMachines(), 500);
      }
    });
    return () => sub.remove();
  }, []);

  // Cargar token guardado al iniciar
  useEffect(() => {
    log.info('App iniciando...');
    loadLogs().then(() => {
      log.info('Logs cargados');
      AsyncStorage.getItem('servereyes_token').then(saved => {
        if (saved) {
          log.info('Token encontrado en storage');
          setToken(saved);
        } else {
          log.info('No hay token guardado');
        }
        setAppReady(true);
      }).catch((err) => {
        log.error(`Error leyendo token: ${err.message}`);
        setAppReady(true);
      });
    });
  }, []);

  // Guardar token cuando cambia
  const setAndSaveToken = async (t: string | null) => {
    if (t) {
      await AsyncStorage.setItem('servereyes_token', t);
      try { WidgetBridge?.setToken(t); } catch {}
    } else {
      await AsyncStorage.removeItem('servereyes_token');
      try { WidgetBridge?.clearToken(); } catch {}
    }
    setToken(t);
  };

  const handleAuth = async () => {
    if (!email.trim() || !password.trim()) { setError('Completa todos los campos'); return; }
    setLoading(true); setError('');
    log.info(`Auth intento: ${isSignUp ? 'register' : 'login'} ${email.trim()}`);
    try {
      const path = isSignUp ? '/api/auth/register' : '/api/auth/login';
      const res = await apiRequest(path, { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      if (res.ok && res.data.token) {
        log.info('Auth exitoso');
        await setAndSaveToken(res.data.token);
      } else if (res.status === 401) {
        log.warn('Auth fallido: credenciales incorrectas');
        setError('Email o contraseña incorrectos');
      } else if (res.status === 409) {
        setError('El email ya esta registrado');
      } else if (res.status === 502 || res.status === 503) {
        log.error(`Servidor no disponible: ${res.status}`);
        setError('Servidor no disponible. Intenta en unos minutos.');
      } else if (res.status === 0) {
        log.error('Sin conexion a internet');
        setError('Sin conexion a internet');
      } else {
        log.warn(`Auth fallido: ${res.status} ${JSON.stringify(res.data)}`);
        setError(res.data?.error || `Error del servidor (${res.status})`);
      }
    } catch (err: any) {
      log.error(`Auth error: ${err.message}`);
      setError(`Error de conexion: ${err.message}`);
    }
    setLoading(false);
  };

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const loadMachines = async (t?: string) => {
    try {
      const res = await apiRequest('/api/machines', {}, t || tokenRef.current);
      if (res.ok) {
        setMachines(res.data);
      } else if (res.status === 401) {
        log.warn('Token expirado, redirigiendo a login');
        setAndSaveToken(null);
      }
    } catch {}
  };

  // Chequear cambios de IP
  const checkIPChanges = async () => {
    if (!tokenRef.current) return;
    try {
      const res = await apiRequest('/api/ip-changes', {}, tokenRef.current);
      if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
        for (const change of res.data) {
          log.info(`[IP CAMBIO] ${change.machine_name}: ${change.previous_public_ip} -> ${change.public_ip}`);
        }
        // Mostrar solo la primera alerta visual
        const change = res.data[0];
        if (change && change.machine_name && change.public_ip) {
          setIpAlert({
            name: change.machine_name,
            oldIp: change.previous_public_ip || '?',
            newIp: change.public_ip
          });
          try { Vibration.vibrate(500); } catch {}
          setTimeout(() => { try { setIpAlert(null); } catch {} }, 15000);
        }
      }
    } catch (e: any) {
      log.error(`checkIPChanges error: ${e.message}`);
    }
  };

  // Auto-refresh cada 10 segundos
  const firstLoadDone = useRef(false);
  useEffect(() => {
    if (!token) { firstLoadDone.current = false; return; }
    log.info('Token activo, iniciando refresh loop');

    // Primera carga: solo maquinas, limpiar alertas de IP pendientes
    const timeout = setTimeout(async () => {
      try {
        await loadMachines();
        // Consumir IP changes pendientes sin mostrar alerta (evita crash post-login)
        await apiRequest('/api/ip-changes', {}, token);
        // Registrar token FCM para push notifications
        await registerFCM();
        log.info('Primera carga completada');
      } catch (e: any) { log.error(`Primera carga error: ${e.message}`); }
      firstLoadDone.current = true;
    }, 1500);

    // Refresh periodico: maquinas + IP changes (solo despues de la primera carga)
    const interval = setInterval(() => {
      loadMachines();
      if (firstLoadDone.current) {
        try { checkIPChanges(); } catch (e: any) { log.error(`checkIP error: ${e.message}`); }
      }
    }, 10000);

    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [token]);

  const addMachine = async () => {
    if (!newName.trim()) return;
    try {
      const res = await apiRequest('/api/machines', { method: 'POST', body: JSON.stringify({ machine_name: newName.trim() }) }, token);
      if (res.ok) { setNewKey(res.data.machine_key); setNewName(''); loadMachines(); }
    } catch { Alert.alert('Error', 'No se pudo registrar'); }
  };

  const updateMachine = async (id: number, data: any) => {
    try {
      await apiRequest(`/api/machines/${id}`, { method: 'PUT', body: JSON.stringify(data) }, token);
      loadMachines();
    } catch {}
  };

  const saveEdit = () => {
    if (!editingMachine) return;
    updateMachine(editingMachine.id, {
      machine_name: editName, grupo: editGrupo || null,
      dns_update_url: editDnsUrl || null, dns_host: editDnsHost || null,
      check_ip_change: editCheckIp, notes: editNotes,
      alert_cpu: editAlertCpu ? parseInt(editAlertCpu) : null,
      alert_ram: editAlertRam ? parseInt(editAlertRam) : null,
      alert_disk: editAlertDisk ? parseInt(editAlertDisk) : null,
      alert_ping: editAlertPing ? parseInt(editAlertPing) : null,
      alert_offline: editAlertOffline
    });
    setEditingMachine(null);
  };

  const loadUptime = async (machineId: number, days: number = 7) => {
    setUptimeLoading(true);
    try {
      const res = await apiRequest(`/api/machines/${machineId}/uptime?days=${days}`, {}, token);
      if (res.ok) setUptimeData(res.data);
    } catch {}
    setUptimeLoading(false);
  };

  const openUptime = (machine: any) => {
    setUptimeMachine(machine);
    setUptimeDays(7);
    loadUptime(machine.id, 7);
  };

  const loadIpHistory = async (machineId: number) => {
    setIpHistoryLoading(true);
    try {
      const res = await apiRequest(`/api/machines/${machineId}/ip-history`, {}, token);
      if (res.ok) setIpHistoryData(res.data);
    } catch {}
    setIpHistoryLoading(false);
  };

  const loadMetrics = async (machineId: number, hours: number) => {
    setMetricsLoading(true);
    try {
      const res = await apiRequest(`/api/machines/${machineId}/metrics?hours=${hours}`, {}, token);
      if (res.ok) setMetricsData(res.data);
    } catch {}
    setMetricsLoading(false);
  };

  const openMetrics = (machine: any) => {
    setMetricsMachine(machine);
    setMetricsHours(24);
    loadMetrics(machine.id, 24);
  };

  const openIpHistory = (machine: any) => {
    setIpHistoryMachine(machine);
    loadIpHistory(machine.id);
  };

  const triggerDnsUpdate = async (machineId: number) => {
    setDnsUpdating(true);
    try {
      const res = await apiRequest(`/api/machines/${machineId}/update-dns`, { method: 'POST' }, token);
      if (res.ok) Alert.alert('DNS Actualizado', `${res.data.host || 'Host'} apunta a ${res.data.ip}`);
      else Alert.alert('Error', res.data.error || 'No se pudo actualizar');
    } catch { Alert.alert('Error', 'Error de conexion'); }
    setDnsUpdating(false);
  };

  const moveMachineUp = (machine: any) => {
    const idx = machines.findIndex(m => m.id === machine.id);
    if (idx <= 0) return;
    const orders = machines.map((m, i) => ({ id: m.id, orden: i, grupo: m.grupo }));
    [orders[idx].orden, orders[idx - 1].orden] = [orders[idx - 1].orden, orders[idx].orden];
    apiRequest('/api/machines-order', { method: 'PUT', body: JSON.stringify({ orders }) }, token);
    const newMachines = [...machines];
    [newMachines[idx], newMachines[idx - 1]] = [newMachines[idx - 1], newMachines[idx]];
    setMachines(newMachines);
  };

  const moveMachineDown = (machine: any) => {
    const idx = machines.findIndex(m => m.id === machine.id);
    if (idx >= machines.length - 1) return;
    const orders = machines.map((m, i) => ({ id: m.id, orden: i, grupo: m.grupo }));
    [orders[idx].orden, orders[idx + 1].orden] = [orders[idx + 1].orden, orders[idx].orden];
    apiRequest('/api/machines-order', { method: 'PUT', body: JSON.stringify({ orders }) }, token);
    const newMachines = [...machines];
    [newMachines[idx], newMachines[idx + 1]] = [newMachines[idx + 1], newMachines[idx]];
    setMachines(newMachines);
  };

  const toggleGroup = (group: string) => {
    const newSet = new Set(expandedGroups);
    if (newSet.has(group)) newSet.delete(group); else newSet.add(group);
    setExpandedGroups(newSet);
  };

  const getGroups = () => {
    const groups: {[key: string]: any[]} = {};
    const sinGrupo: any[] = [];
    machines.forEach(m => {
      if (m.grupo) {
        if (!groups[m.grupo]) groups[m.grupo] = [];
        groups[m.grupo].push(m);
      } else {
        sinGrupo.push(m);
      }
    });
    return { groups, sinGrupo };
  };

  const existingGroups = [...new Set(machines.map(m => m.grupo).filter(Boolean))];

  const confirmPairing = async () => {
    if (pairingCode.length !== 6) { setPairingStatus('Ingresa un codigo de 6 digitos'); return; }
    setPairingStatus('Vinculando...');
    try {
      const res = await apiRequest('/api/pairing/confirm', {
        method: 'POST', body: JSON.stringify({ code: pairingCode })
      }, token);
      if (res.ok) {
        setPairingStatus('');
        setPairingCode('');
        setShowPairing(false);
        loadMachines();
        Alert.alert('Vinculado', `"${res.data.machine.machine_name}" vinculado exitosamente`);
      } else {
        setPairingStatus(res.data.error || 'Error');
      }
    } catch { setPairingStatus('Error de conexion'); }
  };

  const deleteMachine = (m: any) => {
    Alert.alert('Eliminar', `¿Eliminar "${m.machine_name}"?`, [
      { text: 'No' },
      { text: 'Si', style: 'destructive', onPress: async () => {
        await apiRequest(`/api/machines/${m.id}`, { method: 'DELETE' }, token);
        loadMachines();
      }}
    ]);
  };

  const timeSince = (ts: string | null) => {
    if (!ts) return 'Nunca';
    const d = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}min`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    return `${Math.floor(d / 86400)}d`;
  };

  // CONFIG EMAIL / SMTP
  if (showSmtp) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0a1628" />
        <ScrollView contentContainerStyle={{padding: 24, paddingTop: 50}}>
          <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>{'📧'}</Text>
          <Text style={s.title}>Configurar Email</Text>
          <Text style={[s.sub, {marginBottom: 16}]}>Recibir notificaciones por email cuando hay alertas</Text>

          <TouchableOpacity onPress={() => setSmtpEnabled(!smtpEnabled)}
            style={{flexDirection: 'row', alignItems: 'center', marginBottom: 16, paddingVertical: 8}}>
            <View style={{width: 22, height: 22, borderWidth: 2, borderColor: smtpEnabled ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 10, backgroundColor: smtpEnabled ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
              {smtpEnabled && <Text style={{color: '#0a1628', fontSize: 15, fontWeight: '700'}}>✓</Text>}
            </View>
            <Text style={{color: '#ddd', fontSize: 14, fontWeight: '600'}}>Recibir notificaciones por email</Text>
          </TouchableOpacity>

          <Text style={{color: '#ff9800', fontSize: 14, fontWeight: '700', marginBottom: 10}}>SMTP (Gmail u otro)</Text>
          <Text style={{color: '#607d8b', fontSize: 11, marginBottom: 12}}>Para Gmail: deja Host vacio, usa tu email y una contraseña de aplicacion (myaccount.google.com/apppasswords)</Text>

          <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Host SMTP (vacio para Gmail):</Text>
          <TextInput style={s.input} value={smtpHost} onChangeText={setSmtpHost} placeholder="smtp.gmail.com (opcional)" placeholderTextColor="#555" autoCapitalize="none" />

          <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Puerto:</Text>
          <TextInput style={s.input} value={smtpPort} onChangeText={setSmtpPort} placeholder="587" placeholderTextColor="#555" keyboardType="number-pad" />

          <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Email SMTP:</Text>
          <TextInput style={s.input} value={smtpUser} onChangeText={setSmtpUser} placeholder="tu@email.com" placeholderTextColor="#555" keyboardType="email-address" autoCapitalize="none" />

          <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Contraseña SMTP:</Text>
          <TextInput style={s.input} value={smtpPass} onChangeText={setSmtpPass} placeholder="contraseña de aplicacion" placeholderTextColor="#555" secureTextEntry />

          <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Remitente (opcional):</Text>
          <TextInput style={s.input} value={smtpFrom} onChangeText={setSmtpFrom} placeholder="noreply@miempresa.com" placeholderTextColor="#555" autoCapitalize="none" />

          <TouchableOpacity style={s.btn} onPress={async () => {
            const res = await apiRequest('/api/auth/smtp', { method: 'POST', body: JSON.stringify({
              smtp_host: smtpHost || null, smtp_port: parseInt(smtpPort) || 587,
              smtp_user: smtpUser || null, smtp_pass: smtpPass || null, smtp_from: smtpFrom || null,
              email_notifications: smtpEnabled
            }) }, token);
            if (res.ok) Alert.alert('Guardado', 'Configuracion SMTP guardada');
            else Alert.alert('Error', res.data?.error || 'Error');
          }}>
            <Text style={s.btnTxt}>Guardar</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.btn, {backgroundColor: '#ff9800', marginTop: 8}]} onPress={async () => {
            const res = await apiRequest('/api/auth/smtp/test', { method: 'POST' }, token);
            if (res.ok) Alert.alert('Enviado', res.data.message);
            else Alert.alert('Error', res.data?.error || 'Error');
          }}>
            <Text style={s.btnTxt}>Enviar email de prueba</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setShowSmtp(false)}><Text style={s.link}>Volver</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // CAMBIAR CONTRASEÑA
  if (showChangePass) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>🔒</Text>
        <Text style={s.title}>Cambiar contraseña</Text>
        <Text style={[s.sub, {marginBottom: 16}]}></Text>
        <TextInput style={s.input} placeholder="Contraseña actual" placeholderTextColor="#666" value={currentPass} onChangeText={setCurrentPass} secureTextEntry />
        <TextInput style={s.input} placeholder="Nueva contraseña (min 6 caracteres)" placeholderTextColor="#666" value={newPass} onChangeText={setNewPass} secureTextEntry />
        {changePassError ? <Text style={s.err}>{changePassError}</Text> : null}
        <TouchableOpacity style={s.btn} onPress={async () => {
          setChangePassError('');
          const res = await apiRequest('/api/auth/change-password', {
            method: 'POST', body: JSON.stringify({ current_password: currentPass, new_password: newPass })
          }, token);
          if (res.ok) {
            Alert.alert('Listo', 'Contraseña actualizada');
            setShowChangePass(false); setCurrentPass(''); setNewPass('');
          } else {
            setChangePassError(res.data.error || 'Error');
          }
        }}>
          <Text style={s.btnTxt}>Guardar</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setShowChangePass(false); setCurrentPass(''); setNewPass(''); setChangePassError(''); }}>
          <Text style={s.link}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // UPTIME
  if (uptimeMachine) {
    const avgUptime = uptimeData.length > 0
      ? Math.round(uptimeData.reduce((a: number, d: any) => a + d.percentage, 0) / uptimeData.length)
      : 0;

    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#16213e" />
        <View style={{padding: 16, paddingTop: 50, backgroundColor: '#16213e'}}>
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <View>
              <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>📊 Uptime</Text>
              <Text style={{color: '#888', fontSize: 13}}>{uptimeMachine.machine_name}</Text>
            </View>
            <TouchableOpacity onPress={() => setUptimeMachine(null)}
              style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8}}>
              <Text style={{color: '#888', fontWeight: '600'}}>Cerrar</Text>
            </TouchableOpacity>
          </View>
          <View style={{flexDirection: 'row', marginTop: 12}}>
            {[7, 14, 30].map(d => (
              <TouchableOpacity key={d}
                onPress={() => { setUptimeDays(d); loadUptime(uptimeMachine.id, d); }}
                style={{backgroundColor: uptimeDays === d ? '#00d4ff' : '#2a2a4a', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6, marginRight: 8}}>
                <Text style={{color: uptimeDays === d ? '#1a1a2e' : '#888', fontWeight: '600', fontSize: 13}}>{d} dias</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {uptimeLoading ? (
          <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
            <ActivityIndicator size="large" color="#00d4ff" />
          </View>
        ) : (
          <ScrollView style={{flex: 1, padding: 16}}>
            <View style={{alignItems: 'center', marginBottom: 20}}>
              <Text style={{fontSize: 48, fontWeight: '800', color: avgUptime >= 95 ? '#00e676' : avgUptime >= 80 ? '#ff9800' : '#ff5252'}}>
                {avgUptime}%
              </Text>
              <Text style={{color: '#888', fontSize: 14}}>Promedio ultimos {uptimeDays} dias</Text>
            </View>

            {uptimeData.map((day: any, i: number) => {
              const barColor = day.percentage >= 95 ? '#00e676' : day.percentage >= 80 ? '#ff9800' : '#ff5252';
              const dateStr = new Date(day.date + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
              return (
                <View key={i} style={{flexDirection: 'row', alignItems: 'center', marginBottom: 8}}>
                  <Text style={{color: '#888', fontSize: 11, width: 75}}>{dateStr}</Text>
                  <View style={{flex: 1, height: 20, backgroundColor: '#2a2a4a', borderRadius: 4, overflow: 'hidden'}}>
                    <View style={{width: `${day.percentage}%`, height: '100%', backgroundColor: barColor, borderRadius: 4}} />
                  </View>
                  <Text style={{color: '#ddd', fontSize: 12, fontWeight: '600', width: 40, textAlign: 'right'}}>{day.percentage}%</Text>
                </View>
              );
            })}

            <View style={{marginTop: 20, backgroundColor: '#16213e', borderRadius: 12, padding: 16}}>
              <Text style={{color: '#888', fontSize: 12, marginBottom: 8}}>Detalle:</Text>
              {uptimeData.slice(-7).reverse().map((day: any, i: number) => (
                <View key={i} style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
                  <Text style={{color: '#aaa', fontSize: 12}}>{day.date}</Text>
                  <Text style={{color: '#00e676', fontSize: 12}}>{Math.round(day.online_minutes)}min online</Text>
                  <Text style={{color: '#ff5252', fontSize: 12}}>{Math.round(day.offline_minutes)}min offline</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </View>
    );
  }

  // IP HISTORY
  if (ipHistoryMachine) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#16213e" />
        <View style={{padding: 16, paddingTop: 50, backgroundColor: '#16213e'}}>
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <View>
              <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>🌐 Historial de IPs</Text>
              <Text style={{color: '#888', fontSize: 13}}>{ipHistoryMachine.machine_name}</Text>
            </View>
            <TouchableOpacity onPress={() => setIpHistoryMachine(null)}
              style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8}}>
              <Text style={{color: '#888', fontWeight: '600'}}>Cerrar</Text>
            </TouchableOpacity>
          </View>
          <Text style={{color: '#aaa', fontSize: 12, marginTop: 8}}>IP actual: <Text style={{color: '#00e676', fontWeight: '700'}}>{ipHistoryMachine.public_ip || '---'}</Text></Text>
        </View>

        {ipHistoryLoading ? (
          <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
            <ActivityIndicator size="large" color="#00d4ff" />
          </View>
        ) : ipHistoryData.length === 0 ? (
          <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
            <Text style={{fontSize: 40, marginBottom: 10}}>📋</Text>
            <Text style={{color: '#888', fontSize: 16}}>Sin cambios de IP registrados</Text>
            <Text style={{color: '#555', fontSize: 13, marginTop: 4}}>Los cambios futuros apareceran aqui</Text>
          </View>
        ) : (
          <ScrollView style={{flex: 1, padding: 16}}>
            {ipHistoryData.map((entry: any, i: number) => {
              const date = new Date(entry.changed_at);
              const dateStr = date.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
              const timeStr = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
              return (
                <View key={i} style={{backgroundColor: '#16213e', borderRadius: 12, padding: 14, marginBottom: 10}}>
                  <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8}}>
                    <Text style={{color: '#888', fontSize: 12}}>{dateStr}</Text>
                    <Text style={{color: '#888', fontSize: 12}}>{timeStr}</Text>
                  </View>
                  <View style={{flexDirection: 'row', alignItems: 'center'}}>
                    <View style={{flex: 1, alignItems: 'center'}}>
                      <Text style={{color: '#666', fontSize: 10, marginBottom: 2}}>anterior</Text>
                      <Text style={{color: '#ff9800', fontSize: 14, fontWeight: '600'}}>{entry.previous_ip || '---'}</Text>
                    </View>
                    <Text style={{color: '#555', fontSize: 18, marginHorizontal: 8}}>→</Text>
                    <View style={{flex: 1, alignItems: 'center'}}>
                      <Text style={{color: '#666', fontSize: 10, marginBottom: 2}}>nueva</Text>
                      <Text style={{color: '#00e676', fontSize: 14, fontWeight: '600'}}>{entry.public_ip}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
            <View style={{height: 30}} />
          </ScrollView>
        )}
      </View>
    );
  }

  // METRICS HISTORY
  if (metricsMachine) {
    const cpuVals = metricsData.filter(d => d.cpu != null).map(d => parseFloat(d.cpu));
    const ramVals = metricsData.filter(d => d.ram != null).map(d => parseFloat(d.ram));
    const ramTotal = metricsData.find(d => d.ram_total)?.ram_total || 1;
    const pingVals = metricsData.filter(d => d.ping != null).map(d => parseInt(d.ping));

    const renderBar = (values: number[], maxVal: number, color: string) => {
      if (values.length === 0) return <Text style={{color: '#555', fontSize: 12}}>Sin datos</Text>;
      const barW = Math.max(2, Math.floor(300 / values.length));
      return (
        <View style={{flexDirection: 'row', alignItems: 'flex-end', height: 50, backgroundColor: '#0f0f23', borderRadius: 6, padding: 4, overflow: 'hidden'}}>
          {values.map((v, i) => {
            const h = Math.max(1, (v / maxVal) * 42);
            const c = v/maxVal > 0.9 ? '#ff5252' : v/maxVal > 0.7 ? '#ff9800' : color;
            return <View key={i} style={{width: barW, height: h, backgroundColor: c, borderRadius: 1, marginRight: 1}} />;
          })}
        </View>
      );
    };

    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#16213e" />
        <View style={{padding: 16, paddingTop: 50, backgroundColor: '#16213e'}}>
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <View>
              <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>📈 Metricas</Text>
              <Text style={{color: '#888', fontSize: 13}}>{metricsMachine.machine_name}</Text>
            </View>
            <TouchableOpacity onPress={() => setMetricsMachine(null)} style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8}}>
              <Text style={{color: '#888', fontWeight: '600'}}>Cerrar</Text>
            </TouchableOpacity>
          </View>
          <View style={{flexDirection: 'row', marginTop: 12}}>
            {[6, 24, 48, 72, 168].map(h => (
              <TouchableOpacity key={h} onPress={() => { setMetricsHours(h); loadMetrics(metricsMachine.id, h); }}
                style={{backgroundColor: metricsHours === h ? '#00d4ff' : '#2a2a4a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8}}>
                <Text style={{color: metricsHours === h ? '#1a1a2e' : '#888', fontWeight: '600', fontSize: 13}}>{h < 24 ? `${h}h` : `${h/24}d`}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {metricsLoading ? (
          <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}><ActivityIndicator size="large" color="#00d4ff" /></View>
        ) : (
          <ScrollView style={{flex: 1, padding: 16}}>
            <Text style={{color: '#555', fontSize: 11, marginBottom: 16}}>{metricsData.length} puntos de datos</Text>

            <View style={{marginBottom: 20}}>
              <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6}}>
                <Text style={{color: '#888', fontSize: 14, fontWeight: '600'}}>CPU</Text>
                <Text style={{color: '#aaa', fontSize: 12}}>{cpuVals.length > 0 ? `Avg: ${Math.round(cpuVals.reduce((a,b) => a+b, 0)/cpuVals.length)}% | Max: ${Math.round(Math.max(...cpuVals))}%` : '---'}</Text>
              </View>
              {renderBar(cpuVals, 100, '#00e676')}
            </View>

            <View style={{marginBottom: 20}}>
              <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6}}>
                <Text style={{color: '#888', fontSize: 14, fontWeight: '600'}}>RAM</Text>
                <Text style={{color: '#aaa', fontSize: 12}}>{ramVals.length > 0 ? `Avg: ${(ramVals.reduce((a,b) => a+b, 0)/ramVals.length).toFixed(1)}/${ramTotal} GB` : '---'}</Text>
              </View>
              {renderBar(ramVals, ramTotal, '#00d4ff')}
            </View>

            <View style={{marginBottom: 20}}>
              <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6}}>
                <Text style={{color: '#888', fontSize: 14, fontWeight: '600'}}>Ping</Text>
                <Text style={{color: '#aaa', fontSize: 12}}>{pingVals.length > 0 ? `Avg: ${Math.round(pingVals.reduce((a,b) => a+b, 0)/pingVals.length)}ms | Max: ${Math.max(...pingVals)}ms` : '---'}</Text>
              </View>
              {renderBar(pingVals, Math.max(...pingVals, 200), '#ff9800')}
            </View>

            <View style={{height: 30}} />
          </ScrollView>
        )}
      </View>
    );
  }

  // LOGS
  if (showLogs) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#16213e" />
        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 50, backgroundColor: '#16213e'}}>
          <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>📋 Logs</Text>
          <View style={{flexDirection: 'row'}}>
            <TouchableOpacity
              onPress={async () => {
                try {
                  const now = new Date();
                  const fecha = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
                  const hora = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
                  const fileName = `log-${fecha}-${hora}.txt`;
                  const filePath = `${RNFS.CachesDirectoryPath}/${fileName}`;
                  const text = `ServerEyes Logs - ${now.toLocaleString()}\n${'='.repeat(50)}\n\n${_logs.join('\n')}`;
                  await RNFS.writeFile(filePath, text, 'utf8');
                  await RNShare.open({
                    url: `file://${filePath}`,
                    type: 'text/plain',
                    filename: fileName,
                    title: 'ServerEyes Logs',
                  });
                } catch (e: any) {
                  if (e.message !== 'User did not share') {
                    Alert.alert('Error', `No se pudo compartir: ${e.message}`);
                  }
                }
              }}
              style={{backgroundColor: '#00d4ff', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, marginRight: 8}}>
              <Text style={{color: '#1a1a2e', fontWeight: '600', fontSize: 13}}>Compartir</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { _logs = []; saveLogs(); setLogText(''); }}
              style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, marginRight: 8}}>
              <Text style={{color: '#888', fontWeight: '600', fontSize: 13}}>Limpiar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowLogs(false)}
              style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8}}>
              <Text style={{color: '#888', fontWeight: '600', fontSize: 13}}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView style={{flex: 1, padding: 12}}>
          <Text style={{color: '#aaa', fontSize: 11, fontFamily: 'monospace', lineHeight: 18}}>
            {_logs.slice(-200).reverse().join('\n') || 'Sin logs'}
          </Text>
        </ScrollView>
      </View>
    );
  }

  // Pantalla de carga
  if (!appReady) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', alignItems: 'center'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={{fontSize: 40, marginBottom: 10}}>👁</Text>
        <ActivityIndicator size="large" color="#00d4ff" />
      </View>
    );
  }

  // LOGIN
  if (!token) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={s.icon}>👁</Text>
        <Text style={s.title}>ServerEyes</Text>
        <Text style={s.sub}>Monitoreo de maquinas</Text>
        <TextInput style={s.input} placeholder="Email" placeholderTextColor="#666" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="Contraseña" placeholderTextColor="#666" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} />
        <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{flexDirection: 'row', alignItems: 'center', marginBottom: 12}}>
          <View style={{width: 20, height: 20, borderWidth: 2, borderColor: showPassword ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 8, backgroundColor: showPassword ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
            {showPassword && <Text style={{color: '#1a1a2e', fontSize: 14, fontWeight: '700'}}>✓</Text>}
          </View>
          <Text style={{color: '#888', fontSize: 13}}>Ver contraseña</Text>
        </TouchableOpacity>
        {error ? <Text style={s.err}>{error}</Text> : null}
        <TouchableOpacity style={s.btn} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#1a1a2e" /> : <Text style={s.btnTxt}>{isSignUp ? 'Crear cuenta' : 'Iniciar sesion'}</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setIsSignUp(!isSignUp); setError(''); }}>
          <Text style={s.link}>{isSignUp ? 'Ya tengo cuenta' : 'Crear cuenta nueva'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // PAIRING
  if (showPairing) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>🔗</Text>
        <Text style={s.title}>Vincular con codigo</Text>
        <Text style={s.sub}>Ingresa el codigo de 6 digitos que aparece en la pantalla de Windows</Text>
        <TextInput
          style={[s.input, {fontSize: 32, textAlign: 'center', letterSpacing: 8, fontWeight: '700'}]}
          placeholder="000000"
          placeholderTextColor="#444"
          value={pairingCode}
          onChangeText={(t) => setPairingCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
          keyboardType="number-pad"
          maxLength={6}
        />
        {pairingStatus ? <Text style={s.err}>{pairingStatus}</Text> : null}
        <TouchableOpacity style={s.btn} onPress={confirmPairing}>
          <Text style={s.btnTxt}>Vincular</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setShowPairing(false); setPairingCode(''); setPairingStatus(''); }}>
          <Text style={s.link}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ADD MODAL
  if (showAdd) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        {newKey ? (
          <>
            <Text style={s.title}>Maquina registrada</Text>
            <Text style={s.sub}>Clave para el cliente Windows:</Text>
            <Text style={s.key}>{newKey}</Text>
            <Text style={s.sub}>Copia esta clave y pegala en ServerEyes del Windows</Text>
            <TouchableOpacity style={s.btn} onPress={() => { setShowAdd(false); setNewKey(''); }}>
              <Text style={s.btnTxt}>Cerrar</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={s.title}>Agregar maquina</Text>
            <TextInput style={s.input} placeholder="Nombre de la maquina" placeholderTextColor="#666" value={newName} onChangeText={setNewName} />
            <TouchableOpacity style={s.btn} onPress={addMachine}>
              <Text style={s.btnTxt}>Registrar</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAdd(false)}>
              <Text style={s.link}>Cancelar</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  // Render de una maquina (nuevo diseño)
  const renderMachineCard = (item: any) => {
    const isOn = item.is_online;
    const pingColor = item.ping_ms ? (item.ping_ms < 50 ? '#00e676' : item.ping_ms < 150 ? '#ff9800' : '#ff5252') : '#555';
    const cpuColor = item.cpu_usage > 90 ? '#ff5252' : item.cpu_usage > 70 ? '#ff9800' : '#00e676';
    const openEdit = () => { setEditingMachine(item); setEditName(item.machine_name); setEditGrupo(item.grupo || ''); setEditDnsUrl(item.dns_update_url || ''); setEditDnsHost(item.dns_host || ''); setEditCheckIp(item.check_ip_change !== false); setEditNotes(item.notes || ''); setEditAlertCpu(item.alert_cpu ? String(item.alert_cpu) : ''); setEditAlertRam(item.alert_ram ? String(item.alert_ram) : ''); setEditAlertDisk(item.alert_disk ? String(item.alert_disk) : ''); setEditAlertPing(item.alert_ping ? String(item.alert_ping) : ''); setEditAlertOffline(item.alert_offline !== false); };

    const filteredDisks = item.disks && Array.isArray(item.disks) ? item.disks.filter((d: any) => !item.monitored_disks || item.monitored_disks.length === 0 || item.monitored_disks.includes(d.drive)) : [];

    return (
      <TouchableOpacity key={item.id} onPress={openEdit} onLongPress={() => { setShowGroupPicker(item); setNewGroupName(''); }}
        style={{backgroundColor: '#0d1b2a', borderRadius: 16, marginBottom: 14, borderLeftWidth: 3, borderLeftColor: isOn ? '#00e676' : '#ff5252', overflow: 'hidden'}}>
        {/* Header */}
        <View style={{padding: 16, paddingBottom: 8}}>
          <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 6}}>
            <View style={{width: 12, height: 12, borderRadius: 6, marginRight: 10, backgroundColor: isOn ? '#00e676' : '#ff5252'}} />
            <Text style={{flex: 1, fontSize: 18, fontWeight: '800', color: '#eee'}}>{item.machine_name}</Text>
            <View style={{backgroundColor: isOn ? '#0d2818' : '#2d1117', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6}}>
              <Text style={{fontSize: 11, fontWeight: '800', color: isOn ? '#00e676' : '#ff5252'}}>{isOn ? 'ONLINE' : 'OFFLINE'}</Text>
            </View>
          </View>
          {item.grupo && <Text style={{color: '#00d4ff', fontSize: 12, fontWeight: '600', marginBottom: 2}}>{'📁'} {item.grupo}</Text>}
          {item.is_shared && <Text style={{color: '#ff9800', fontSize: 11, marginBottom: 2}}>{'👥'} Compartida por {item.owner_name || item.owner_email}</Text>}
          {item.geo_city && <Text style={{color: '#607d8b', fontSize: 11, marginBottom: 2}}>{'📍'} {item.geo_city}, {item.geo_region}, {item.geo_country}</Text>}
          {item.check_ip_change === false && <Text style={{color: '#555', fontSize: 10}}>{'🔕'} Monitoreo de IP desactivado</Text>}
        </View>

        {/* IPs box */}
        <View style={{flexDirection: 'row', marginHorizontal: 16, marginBottom: 10, backgroundColor: '#111d2e', borderRadius: 10, overflow: 'hidden'}}>
          <View style={{flex: 1, padding: 10, borderRightWidth: 1, borderRightColor: '#1a2a3a'}}>
            <Text style={{color: '#607d8b', fontSize: 10, marginBottom: 3}}>{'🌐'} IP Publica</Text>
            <Text style={{color: '#eee', fontSize: 14, fontWeight: '700'}}>{item.public_ip || '---'}</Text>
          </View>
          <View style={{flex: 1, padding: 10}}>
            <Text style={{color: '#607d8b', fontSize: 10, marginBottom: 3}}>{'🏠'} IP Local</Text>
            {(item.local_ip || '---').split(' | ').map((ip: string, i: number) => (
              <Text key={i} style={{color: '#eee', fontSize: 12, fontWeight: '600'}}>{ip.trim()}</Text>
            ))}
          </View>
        </View>

        {/* Metrics grid */}
        <View style={{flexDirection: 'row', marginHorizontal: 16, marginBottom: 10}}>
          <View style={{flex: 1, backgroundColor: '#111d2e', borderRadius: 10, padding: 8, marginRight: 6, alignItems: 'center'}}>
            <Text style={{color: '#607d8b', fontSize: 9}}>{'💓'} Heartbeat</Text>
            <Text style={{color: '#eee', fontSize: 15, fontWeight: '800', marginTop: 2}}>{timeSince(item.last_heartbeat)}</Text>
          </View>
          <View style={{flex: 1, backgroundColor: '#111d2e', borderRadius: 10, padding: 8, marginRight: 6, alignItems: 'center'}}>
            <Text style={{color: '#607d8b', fontSize: 9}}>{'📡'} Ping</Text>
            <Text style={{color: pingColor, fontSize: 15, fontWeight: '800', marginTop: 2}}>{item.ping_ms ? `${item.ping_ms} ms` : '---'}</Text>
          </View>
          <View style={{flex: 1, backgroundColor: '#111d2e', borderRadius: 10, padding: 8, marginRight: 6, alignItems: 'center'}}>
            <Text style={{color: '#607d8b', fontSize: 9}}>{'🌐'} Velocidad</Text>
            <Text style={{color: '#00d4ff', fontSize: 15, fontWeight: '800', marginTop: 2}}>{item.download_mbps ? `${item.download_mbps} Mbps` : '---'}</Text>
          </View>
          <View style={{flex: 1, backgroundColor: '#111d2e', borderRadius: 10, padding: 8, alignItems: 'center'}}>
            <Text style={{color: '#607d8b', fontSize: 9}}>{'🖥'} CPU</Text>
            <Text style={{color: item.cpu_usage != null ? cpuColor : '#555', fontSize: 15, fontWeight: '800', marginTop: 2}}>{item.cpu_usage != null ? `${item.cpu_usage}%` : '---'}</Text>
          </View>
        </View>

        {/* RAM + Disks bars */}
        <View style={{marginHorizontal: 16, marginBottom: 10}}>
          {(item.ram_usage != null) && (
            <View style={{marginBottom: 6}}>
              <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3}}>
                <Text style={{color: '#607d8b', fontSize: 11}}>{'💾'} RAM</Text>
                <Text style={{color: '#aaa', fontSize: 11, fontWeight: '700'}}>{item.ram_usage} / {item.ram_total} GB</Text>
              </View>
              <View style={{height: 7, backgroundColor: '#1a2a3a', borderRadius: 4, overflow: 'hidden'}}>
                <View style={{width: `${Math.min((item.ram_usage / item.ram_total) * 100, 100)}%`, height: '100%', backgroundColor: (item.ram_usage / item.ram_total) > 0.9 ? '#ff5252' : (item.ram_usage / item.ram_total) > 0.7 ? '#ff9800' : '#00e676', borderRadius: 4}} />
              </View>
            </View>
          )}
          {filteredDisks.length > 0 ? filteredDisks.map((disk: any, idx: number) => {
            const pct = disk.total > 0 ? (disk.used / disk.total) : 0;
            return (
              <View key={idx} style={{marginBottom: 4}}>
                <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3}}>
                  <Text style={{color: '#607d8b', fontSize: 11}}>{'💿'} Disco {disk.drive}</Text>
                  <Text style={{color: '#aaa', fontSize: 11, fontWeight: '700'}}>{disk.used} / {disk.total} GB ({Math.round(disk.free)} GB libre)</Text>
                </View>
                <View style={{height: 7, backgroundColor: '#1a2a3a', borderRadius: 4, overflow: 'hidden'}}>
                  <View style={{width: `${Math.min(pct * 100, 100)}%`, height: '100%', backgroundColor: pct > 0.95 ? '#ff5252' : pct > 0.85 ? '#ff9800' : '#00e676', borderRadius: 4}} />
                </View>
              </View>
            );
          }) : null}
        </View>

        {/* OS info */}
        {item.os_info && <Text style={{color: '#3a5068', fontSize: 10, marginHorizontal: 16, marginBottom: 8}}>{item.os_info}</Text>}

        {/* Action buttons */}
        <View style={{flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1a2a3a', paddingVertical: 8, paddingHorizontal: 12, flexWrap: 'wrap'}}>
          {[
            {icon: '⏱', label: 'Uptime', action: () => openUptime(item)},
            {icon: '📈', label: 'Metricas', action: () => openMetrics(item)},
            {icon: '🌐', label: 'IPs', action: () => openIpHistory(item)},
            {icon: '💿', label: 'Discos', action: () => { setDetailMachine(item); setDetailMonitored(item.monitored_disks || []); const ad: {[k:string]:string} = {}; if (item.alert_disks) { Object.entries(item.alert_disks).forEach(([k,v]) => { ad[k] = String(v); }); } setDetailAlertDisks(ad); }},
            {icon: '📋', label: 'Logs', action: async () => { const res = await apiRequest(`/api/machines/${item.id}/logs`, {}, token); if (res.ok) Alert.alert('Logs: ' + item.machine_name, res.data.logs || 'Sin logs'); }},
            {icon: '⚙', label: 'Servicios', action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/services`, {}, token);
              if (res.ok) {
                const svcs = (res.data.services || []).map((s: any) => `${s.state === 'RUNNING' ? '🟢' : '🔴'} ${s.display} (${s.state})`).join('\n');
                const ports = (res.data.open_ports || []).join(', ');
                Alert.alert(item.machine_name, (svcs || 'Sin servicios') + '\n\nPuertos: ' + (ports || 'Sin datos'));
              }
            }},
            {icon: '💾', label: 'Config', action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/config`, {}, token);
              if (res.ok) Alert.alert('Config: ' + item.machine_name, res.data.config ? JSON.stringify(res.data.config, null, 2) + '\n\nBackup: ' + (res.data.backed_up_at ? new Date(res.data.backed_up_at).toLocaleString() : '---') : 'Sin backup');
            }},
            {icon: '🛡', label: 'Backup', action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/backup`, {}, token);
              if (res.ok) {
                const d = res.data;
                const status = d.status === 'ok' || d.status === 'found' ? '✅ Backup OK' : d.status === 'error' ? '❌ Error' : '⚠ Sin datos';
                const info = [status, d.last_backup ? 'Ultimo: ' + d.last_backup : null, d.last_folder ? 'Carpeta: ' + d.last_folder : null, d.level ? 'Nivel: ' + d.level : null, d.message || null].filter(Boolean).join('\n');
                Alert.alert('Backup: ' + item.machine_name, info);
              }
            }},
          ].map((btn, i) => (
            <TouchableOpacity key={i} onPress={btn.action} style={{paddingVertical: 6, paddingHorizontal: 10}}>
              <Text style={{color: '#607d8b', fontSize: 12}}>{btn.icon} {btn.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    );
  };

  // Vista por grupos
  const renderGroupView = () => {
    const { groups, sinGrupo } = getGroups();
    const groupNames = Object.keys(groups).sort();

    return (
      <View style={{padding: 16, paddingBottom: 80}}>
        {groupNames.map(groupName => (
          <View key={groupName} style={{marginBottom: 12}}>
            <TouchableOpacity
              onPress={() => toggleGroup(groupName)}
              style={{backgroundColor: '#16213e', borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center'}}>
              <Text style={{fontSize: 16, marginRight: 8}}>{expandedGroups.has(groupName) ? '📂' : '📁'}</Text>
              <Text style={{flex: 1, fontSize: 16, fontWeight: '700', color: '#00d4ff'}}>{groupName}</Text>
              <Text style={{color: '#888', fontSize: 13}}>{groups[groupName].length} maq.</Text>
              <Text style={{color: '#555', fontSize: 14, marginLeft: 8}}>{expandedGroups.has(groupName) ? '▼' : '▶'}</Text>
            </TouchableOpacity>
            {expandedGroups.has(groupName) && (
              <View style={{marginTop: 8, paddingLeft: 8}}>
                {groups[groupName].map(m => renderMachineCard(m))}
              </View>
            )}
          </View>
        ))}
        {sinGrupo.length > 0 && (
          <View>
            {groupNames.length > 0 && (
              <Text style={{color: '#555', fontSize: 13, marginBottom: 8, marginTop: 8}}>Sin grupo</Text>
            )}
            {sinGrupo.map(m => renderMachineCard(m))}
          </View>
        )}
      </View>
    );
  };

  // MACHINE DETAIL - ver todos los discos y elegir cuales monitorear
  if (detailMachine) {
    const allDisks: any[] = detailMachine.disks && Array.isArray(detailMachine.disks) ? detailMachine.disks : [];
    const toggleDisk = (drive: string) => {
      setDetailMonitored(prev => prev.includes(drive) ? prev.filter(d => d !== drive) : [...prev, drive]);
    };
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#16213e" />
        <View style={{padding: 16, paddingTop: 50, backgroundColor: '#16213e'}}>
          <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
            <View>
              <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>{detailMachine.machine_name}</Text>
              <Text style={{color: detailMachine.is_online ? '#00e676' : '#ff5252', fontSize: 12, fontWeight: '700'}}>{detailMachine.is_online ? 'ONLINE' : 'OFFLINE'}</Text>
            </View>
            <TouchableOpacity onPress={() => setDetailMachine(null)}
              style={{backgroundColor: '#2a2a4a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8}}>
              <Text style={{color: '#888', fontWeight: '600'}}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView style={{flex: 1, padding: 16}}>
          {/* Info general */}
          <View style={{backgroundColor: '#16213e', borderRadius: 12, padding: 14, marginBottom: 12}}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}><Text style={{color: '#888', fontSize: 13}}>IP Publica:</Text><Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{detailMachine.public_ip || '---'}</Text></View>
            <View style={{marginBottom: 4}}><Text style={{color: '#888', fontSize: 13}}>IP Local:</Text>
              {(detailMachine.local_ip || '---').split(' | ').map((ip: string, i: number) => <Text key={i} style={{color: '#ddd', fontSize: 13, fontWeight: '600', paddingLeft: 8}}>{ip.trim()}</Text>)}
            </View>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}><Text style={{color: '#888', fontSize: 13}}>Ping:</Text><Text style={{color: detailMachine.ping_ms ? (detailMachine.ping_ms < 50 ? '#00e676' : detailMachine.ping_ms < 150 ? '#ff9800' : '#ff5252') : '#555', fontSize: 13, fontWeight: '600'}}>{detailMachine.ping_ms ? `${detailMachine.ping_ms}ms` : '---'}</Text></View>
            {detailMachine.cpu_usage != null && <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}><Text style={{color: '#888', fontSize: 13}}>CPU:</Text><Text style={{color: detailMachine.cpu_usage > 90 ? '#ff5252' : detailMachine.cpu_usage > 70 ? '#ff9800' : '#00e676', fontSize: 13, fontWeight: '600'}}>{detailMachine.cpu_usage}%</Text></View>}
            {detailMachine.ram_usage != null && <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}><Text style={{color: '#888', fontSize: 13}}>RAM:</Text><Text style={{color: '#aaa', fontSize: 13, fontWeight: '600'}}>{detailMachine.ram_usage}/{detailMachine.ram_total} GB</Text></View>}
            {detailMachine.os_info && <Text style={{color: '#555', fontSize: 11, marginTop: 4}}>{detailMachine.os_info}</Text>}
            {detailMachine.agent_version && <Text style={{color: '#555', fontSize: 11, marginTop: 2}}>Agente v{detailMachine.agent_version}</Text>}
          </View>

          {/* Todos los discos */}
          <Text style={{color: '#00d4ff', fontSize: 16, fontWeight: '700', marginBottom: 10}}>Discos ({allDisks.length})</Text>
          {allDisks.length === 0 ? (
            <Text style={{color: '#888', fontSize: 13, textAlign: 'center', paddingVertical: 20}}>Sin datos de discos. Actualiza el agente.</Text>
          ) : allDisks.map((disk: any, idx: number) => {
            const pct = disk.total > 0 ? (disk.used / disk.total) : 0;
            const isMonitored = detailMonitored.includes(disk.drive);
            return (
              <View key={idx} style={{backgroundColor: '#16213e', borderRadius: 12, padding: 14, marginBottom: 10}}>
                <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 8}}>
                  <Text style={{flex: 1, color: '#eee', fontSize: 16, fontWeight: '700'}}>Disco {disk.drive}</Text>
                  <Text style={{color: pct > 0.95 ? '#ff5252' : pct > 0.85 ? '#ff9800' : '#00e676', fontSize: 16, fontWeight: '800'}}>{Math.round(pct * 100)}%</Text>
                </View>
                <View style={{height: 8, backgroundColor: '#2a2a4a', borderRadius: 4, overflow: 'hidden', marginBottom: 8}}>
                  <View style={{width: `${Math.min(pct * 100, 100)}%`, height: '100%', backgroundColor: pct > 0.95 ? '#ff5252' : pct > 0.85 ? '#ff9800' : '#00e676', borderRadius: 4}} />
                </View>
                <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2}}>
                  <Text style={{color: '#888', fontSize: 12}}>Usado:</Text><Text style={{color: '#ddd', fontSize: 12, fontWeight: '600'}}>{disk.used} GB</Text>
                </View>
                <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2}}>
                  <Text style={{color: '#888', fontSize: 12}}>Libre:</Text><Text style={{color: '#00e676', fontSize: 12, fontWeight: '600'}}>{disk.free} GB</Text>
                </View>
                <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6}}>
                  <Text style={{color: '#888', fontSize: 12}}>Total:</Text><Text style={{color: '#ddd', fontSize: 12, fontWeight: '600'}}>{disk.total} GB</Text>
                </View>
                <View style={{flexDirection: 'row', alignItems: 'center', paddingTop: 6, borderTopWidth: 1, borderTopColor: '#2a2a4a'}}>
                  <TouchableOpacity onPress={() => toggleDisk(disk.drive)} style={{flexDirection: 'row', alignItems: 'center', flex: 1}}>
                    <View style={{width: 20, height: 20, borderWidth: 2, borderColor: isMonitored ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 8, backgroundColor: isMonitored ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
                      {isMonitored && <Text style={{color: '#1a1a2e', fontSize: 13, fontWeight: '700'}}>✓</Text>}
                    </View>
                    <Text style={{color: '#888', fontSize: 12}}>En resumen</Text>
                  </TouchableOpacity>
                  <Text style={{color: '#ff9800', fontSize: 11, marginRight: 6}}>Alerta %:</Text>
                  <TextInput
                    style={{backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#2a2a4a', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, width: 50, color: '#eee', fontSize: 13, textAlign: 'center'}}
                    value={detailAlertDisks[disk.drive] || ''}
                    onChangeText={t => setDetailAlertDisks(prev => ({...prev, [disk.drive]: t.replace(/[^0-9]/g, '')}))}
                    placeholder="--"
                    placeholderTextColor="#555"
                    keyboardType="number-pad"
                    maxLength={3}
                  />
                </View>
              </View>
            );
          })}

          <TouchableOpacity style={[s.btn, {marginTop: 8}]} onPress={async () => {
            const alertDisksClean: {[k:string]: number} = {};
            Object.entries(detailAlertDisks).forEach(([k, v]) => { if (v && parseInt(v) > 0) alertDisksClean[k] = parseInt(v as string); });
            await updateMachine(detailMachine.id, { monitored_disks: detailMonitored, alert_disks: alertDisksClean });
            Alert.alert('Guardado', detailMonitored.length > 0 ? `Mostrando: ${detailMonitored.join(', ')}` : 'Mostrando todos los discos');
            setDetailMachine(null);
          }}>
            <Text style={s.btnTxt}>Guardar seleccion</Text>
          </TouchableOpacity>
          <Text style={{color: '#666', fontSize: 11, textAlign: 'center', marginTop: 6, marginBottom: 30}}>Si no seleccionas ninguno, se muestran todos en el resumen.</Text>
        </ScrollView>
      </View>
    );
  }

  // SHARE PICKER - elegir maquinas para compartir con un tecnico
  if (shareUserId) {
    const myMachines = machines.filter(m => !m.is_shared);
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <ScrollView contentContainerStyle={{padding: 24, paddingTop: 50}}>
          <Text style={s.title}>Compartir maquinas</Text>
          <Text style={[s.sub, {marginBottom: 16}]}>Selecciona las maquinas que este tecnico podra ver</Text>
          {myMachines.map(m => (
            <TouchableOpacity key={m.id} onPress={() => {
              const next = new Set(shareSelected);
              if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
              setShareSelected(next);
            }} style={{flexDirection: 'row', alignItems: 'center', backgroundColor: '#16213e', borderRadius: 10, padding: 14, marginBottom: 8}}>
              <View style={{width: 22, height: 22, borderWidth: 2, borderColor: shareSelected.has(m.id) ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 12, backgroundColor: shareSelected.has(m.id) ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
                {shareSelected.has(m.id) && <Text style={{color: '#1a1a2e', fontSize: 15, fontWeight: '700'}}>✓</Text>}
              </View>
              <View style={{flex: 1}}>
                <Text style={{color: '#eee', fontSize: 15, fontWeight: '600'}}>{m.machine_name}</Text>
                {m.grupo && <Text style={{color: '#00d4ff', fontSize: 11}}>{m.grupo}</Text>}
              </View>
              <View style={{width: 8, height: 8, borderRadius: 4, backgroundColor: m.is_online ? '#00e676' : '#ff5252'}} />
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.btn} onPress={async () => {
            await apiRequest('/api/machines/share', { method: 'POST', body: JSON.stringify({ user_id: shareUserId, machine_ids: [...shareSelected] }) }, token);
            Alert.alert('Listo', `${shareSelected.size} maquina(s) compartidas`);
            setShareUserId(null);
            // Recargar org
            const res = await apiRequest('/api/organization', {}, token);
            if (res.ok) setOrgData(res.data);
          }}>
            <Text style={s.btnTxt}>Guardar ({shareSelected.size})</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShareUserId(null)}><Text style={s.link}>Cancelar</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // TEAM / ORGANIZATION
  if (showTeam) {
    const org = orgData?.organization;
    const team = orgData?.team || [];
    const invitations = orgData?.invitations?.filter((i: any) => i.status === 'pending') || [];
    const isOwner = !org || team.find((t: any) => t.id === parseInt(String(token?.split('.')[1] ? JSON.parse(atob(token!.split('.')[1])).id : '0')))?.role === 'owner' || !org;

    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <ScrollView contentContainerStyle={{padding: 24, paddingTop: 50}}>
          <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>&#128101;</Text>
          <Text style={s.title}>Empresa y Equipo</Text>

          {!org ? (
            <>
              <Text style={[s.sub, {marginBottom: 16}]}>Configura tu empresa para invitar tecnicos</Text>
              <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Nombre de la empresa:</Text>
              <TextInput style={s.input} value={orgName} onChangeText={setOrgName} placeholder="Mi Empresa SRL" placeholderTextColor="#666" />
              <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Direccion (opcional):</Text>
              <TextInput style={s.input} value={orgAddress} onChangeText={setOrgAddress} placeholder="Calle 123, Ciudad" placeholderTextColor="#666" />
              <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Telefono (opcional):</Text>
              <TextInput style={s.input} value={orgPhone} onChangeText={setOrgPhone} placeholder="+54 11..." placeholderTextColor="#666" keyboardType="phone-pad" />
              <TouchableOpacity style={s.btn} onPress={async () => {
                if (!orgName.trim()) return;
                const res = await apiRequest('/api/organization', { method: 'POST', body: JSON.stringify({ name: orgName.trim(), address: orgAddress, phone: orgPhone }) }, token);
                if (res.ok) {
                  Alert.alert('Listo', 'Empresa creada');
                  const r2 = await apiRequest('/api/organization', {}, token);
                  if (r2.ok) setOrgData(r2.data);
                } else Alert.alert('Error', res.data?.error || 'Error');
              }}><Text style={s.btnTxt}>Crear empresa</Text></TouchableOpacity>

              <View style={{marginTop: 30, borderTopWidth: 1, borderTopColor: '#2a2a4a', paddingTop: 20}}>
                <Text style={{color: '#888', fontSize: 14, textAlign: 'center', marginBottom: 12}}>¿Te invitaron a un equipo?</Text>
                <TextInput style={[s.input, {textAlign: 'center', fontSize: 18, letterSpacing: 4}]} value={joinCode} onChangeText={setJoinCode} placeholder="CODIGO" placeholderTextColor="#555" autoCapitalize="characters" />
                <TouchableOpacity style={[s.btn, {backgroundColor: '#ff9800'}]} onPress={async () => {
                  if (!joinCode.trim()) return;
                  const res = await apiRequest('/api/organization/join', { method: 'POST', body: JSON.stringify({ code: joinCode.trim() }) }, token);
                  if (res.ok) { Alert.alert('Listo', res.data.message); const r2 = await apiRequest('/api/organization', {}, token); if (r2.ok) setOrgData(r2.data); setJoinCode(''); }
                  else Alert.alert('Error', res.data?.error || 'Error');
                }}><Text style={s.btnTxt}>Unirme</Text></TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={[s.sub, {marginBottom: 16}]}>{org.name}</Text>

              {/* Equipo */}
              <Text style={{color: '#00d4ff', fontSize: 16, fontWeight: '700', marginBottom: 10}}>Equipo ({team.length})</Text>
              {team.map((member: any) => (
                <View key={member.id} style={{backgroundColor: '#16213e', borderRadius: 10, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center'}}>
                  <View style={{flex: 1}}>
                    <Text style={{color: '#eee', fontSize: 15, fontWeight: '600'}}>{member.nombre || member.email}</Text>
                    <Text style={{color: '#888', fontSize: 12}}>{member.email}</Text>
                  </View>
                  <Text style={{color: member.role === 'owner' ? '#ff9800' : '#00d4ff', fontSize: 12, fontWeight: '600', marginRight: 8}}>
                    {member.role === 'owner' ? 'OWNER' : 'TECNICO'}
                  </Text>
                  {member.role === 'technician' && (
                    <View style={{flexDirection: 'row'}}>
                      <TouchableOpacity onPress={async () => {
                        const res = await apiRequest(`/api/machines/shared/${member.id}`, {}, token);
                        const ids = res.ok ? new Set(res.data as number[]) : new Set<number>();
                        setShareSelected(ids);
                        setShareUserId(member.id);
                      }} style={{backgroundColor: '#0a3d62', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6}}>
                        <Text style={{color: '#00d4ff', fontSize: 11, fontWeight: '600'}}>Compartir</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => {
                        Alert.alert('Remover', `¿Remover a ${member.nombre || member.email}?`, [
                          { text: 'No' },
                          { text: 'Si', style: 'destructive', onPress: async () => {
                            await apiRequest(`/api/organization/member/${member.id}`, { method: 'DELETE' }, token);
                            const r2 = await apiRequest('/api/organization', {}, token);
                            if (r2.ok) setOrgData(r2.data);
                          }}
                        ]);
                      }} style={{backgroundColor: '#2d1117', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6}}>
                        <Text style={{color: '#ff5252', fontSize: 11, fontWeight: '600'}}>X</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              ))}

              {/* Invitar */}
              <Text style={{color: '#ff9800', fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 10}}>Invitar tecnico</Text>
              <View style={{flexDirection: 'row', marginBottom: 8}}>
                <TextInput style={[s.input, {flex: 1, marginBottom: 0, marginRight: 8}]} value={inviteEmail} onChangeText={setInviteEmail} placeholder="email@tecnico.com" placeholderTextColor="#666" keyboardType="email-address" autoCapitalize="none" />
                <TouchableOpacity style={{backgroundColor: '#ff9800', borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center'}} onPress={async () => {
                  if (!inviteEmail.trim()) return;
                  const res = await apiRequest('/api/organization/invite', { method: 'POST', body: JSON.stringify({ email: inviteEmail.trim() }) }, token);
                  if (res.ok) {
                    Alert.alert('Invitacion', `Codigo: ${res.data.code}\n\nComparti este codigo con ${inviteEmail.trim()}`);
                    setInviteEmail('');
                    const r2 = await apiRequest('/api/organization', {}, token);
                    if (r2.ok) setOrgData(r2.data);
                  } else Alert.alert('Error', res.data?.error || 'Error');
                }}>
                  <Text style={{color: '#1a1a2e', fontWeight: '700'}}>Invitar</Text>
                </TouchableOpacity>
              </View>

              {/* Invitaciones pendientes */}
              {invitations.length > 0 && (
                <>
                  <Text style={{color: '#888', fontSize: 13, marginTop: 8, marginBottom: 6}}>Pendientes:</Text>
                  {invitations.map((inv: any) => (
                    <View key={inv.id} style={{backgroundColor: '#16213e', borderRadius: 8, padding: 10, marginBottom: 6, flexDirection: 'row', alignItems: 'center'}}>
                      <View style={{flex: 1}}>
                        <Text style={{color: '#ddd', fontSize: 13}}>{inv.email}</Text>
                        <Text style={{color: '#ff9800', fontSize: 11}}>Codigo: {inv.code}</Text>
                      </View>
                      <TouchableOpacity onPress={async () => {
                        await apiRequest(`/api/organization/invite/${inv.id}`, { method: 'DELETE' }, token);
                        const r2 = await apiRequest('/api/organization', {}, token);
                        if (r2.ok) setOrgData(r2.data);
                      }}>
                        <Text style={{color: '#ff5252', fontSize: 12}}>Cancelar</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              )}
            </>
          )}

          <TouchableOpacity onPress={() => setShowTeam(false)} style={{marginTop: 20}}><Text style={s.link}>Volver</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // AGENT UPDATE
  if (showAgentUpdate) {
    const outdated = machines.filter(m => m.agent_version && agentVersion && m.agent_version !== agentVersion);
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <ScrollView contentContainerStyle={{padding: 24, paddingTop: 50}}>
          <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>&#128228;</Text>
          <Text style={s.title}>Actualizar Agente</Text>
          <Text style={[s.sub, {marginBottom: 20}]}>Los agentes se actualizan en el proximo heartbeat</Text>

          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Version:</Text>
          <TextInput style={s.input} value={agentVersion} onChangeText={setAgentVersion} placeholder="ej: 1.1.0" placeholderTextColor="#666" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>URL de descarga del exe:</Text>
          <TextInput style={[s.input, {fontSize: 13}]} value={agentUrl} onChangeText={setAgentUrl} placeholder="https://..." placeholderTextColor="#666" autoCapitalize="none" />
          <Text style={{color: '#555', fontSize: 11, marginBottom: 16}}>Los agentes descargan el exe automaticamente cuando detectan una version nueva.</Text>

          <TouchableOpacity style={s.btn} onPress={async () => {
            if (!agentVersion.trim() || !agentUrl.trim()) { Alert.alert('Error', 'Completa version y URL'); return; }
            const res = await apiRequest('/api/agent/version', { method: 'POST', body: JSON.stringify({ version: agentVersion.trim(), url: agentUrl.trim() }) }, token);
            if (res.ok) { Alert.alert('Guardado', `Version ${agentVersion} configurada`); setShowAgentUpdate(false); }
            else Alert.alert('Error', res.data?.error || 'Error');
          }}>
            <Text style={s.btnTxt}>Guardar</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowAgentUpdate(false)}>
            <Text style={s.link}>Cancelar</Text>
          </TouchableOpacity>

          {outdated.length > 0 && (
            <View style={{marginTop: 24, backgroundColor: '#16213e', borderRadius: 12, padding: 16}}>
              <Text style={{color: '#ff9800', fontSize: 14, fontWeight: '700', marginBottom: 8}}>{outdated.length} maquina(s) pendientes</Text>
              {outdated.map(m => (
                <View key={m.id} style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
                  <Text style={{color: '#ddd', fontSize: 13}}>{m.machine_name}</Text>
                  <Text style={{color: '#888', fontSize: 13}}>v{m.agent_version}</Text>
                </View>
              ))}
            </View>
          )}

          {machines.filter(m => m.agent_version).length > 0 && (
            <View style={{marginTop: 16, backgroundColor: '#16213e', borderRadius: 12, padding: 16}}>
              <Text style={{color: '#888', fontSize: 12, marginBottom: 8}}>Versiones instaladas:</Text>
              {machines.filter(m => m.agent_version).map(m => (
                <View key={m.id} style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
                  <Text style={{color: '#ddd', fontSize: 13}}>{m.machine_name}</Text>
                  <Text style={{color: m.agent_version === agentVersion ? '#00e676' : '#ff9800', fontSize: 13, fontWeight: '600'}}>v{m.agent_version}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // GROUP PICKER (long-press)
  if (showGroupPicker) {
    const pickerMachine = showGroupPicker;
    const allGroups = [...new Set(machines.map(m => m.grupo).filter(Boolean))];
    const moveToGroup = (grupo: string | null) => {
      updateMachine(pickerMachine.id, { grupo });
      setShowGroupPicker(null);
    };
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', padding: 24}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>📁</Text>
        <Text style={s.title}>Mover a grupo</Text>
        <Text style={{color: '#888', textAlign: 'center', fontSize: 13, marginBottom: 20}}>{pickerMachine.machine_name}</Text>

        <ScrollView style={{maxHeight: 350}}>
          {allGroups.map(g => (
            <TouchableOpacity key={g} onPress={() => moveToGroup(g!)}
              style={{backgroundColor: pickerMachine.grupo === g ? '#0a3d62' : '#16213e', borderRadius: 12, padding: 16, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: pickerMachine.grupo === g ? 1 : 0, borderColor: '#00d4ff'}}>
              <Text style={{fontSize: 18, marginRight: 12}}>{pickerMachine.grupo === g ? '📂' : '📁'}</Text>
              <Text style={{flex: 1, color: '#ddd', fontSize: 16, fontWeight: '600'}}>{g}</Text>
              {pickerMachine.grupo === g && <Text style={{color: '#00d4ff', fontSize: 12}}>actual</Text>}
            </TouchableOpacity>
          ))}

          <View style={{flexDirection: 'row', marginTop: 4, marginBottom: 8}}>
            <TextInput
              style={[s.input, {flex: 1, marginBottom: 0, marginRight: 8}]}
              placeholder="Nuevo grupo..."
              placeholderTextColor="#666"
              value={newGroupName}
              onChangeText={setNewGroupName}
            />
            <TouchableOpacity
              onPress={() => { if (newGroupName.trim()) { moveToGroup(newGroupName.trim()); setNewGroupName(''); } }}
              style={{backgroundColor: newGroupName.trim() ? '#00d4ff' : '#2a2a4a', borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center'}}>
              <Text style={{color: newGroupName.trim() ? '#1a1a2e' : '#555', fontWeight: '700', fontSize: 16}}>+</Text>
            </TouchableOpacity>
          </View>

          {pickerMachine.grupo && (
            <TouchableOpacity onPress={() => moveToGroup(null)}
              style={{backgroundColor: '#16213e', borderRadius: 12, padding: 16, marginBottom: 8, flexDirection: 'row', alignItems: 'center'}}>
              <Text style={{fontSize: 18, marginRight: 12}}>✖</Text>
              <Text style={{color: '#888', fontSize: 16}}>Quitar de grupo</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        <TouchableOpacity onPress={() => setShowGroupPicker(null)} style={{marginTop: 16}}>
          <Text style={s.link}>Cancelar</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => { setShowGroupPicker(null); deleteMachine(pickerMachine); }} style={{marginTop: 16}}>
          <Text style={{color: '#ff5252', textAlign: 'center', fontSize: 14}}>Eliminar maquina</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // EDIT MODAL
  if (editingMachine) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <ScrollView contentContainerStyle={{padding: 24, paddingTop: 50}}>
        <Text style={{fontSize: 40, textAlign: 'center', marginBottom: 10}}>✏️</Text>
        <Text style={s.title}>Editar maquina</Text>
        <Text style={[s.sub, {marginBottom: 16}]}>Toca fuera para cerrar</Text>
        <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Nombre:</Text>
        <TextInput style={s.input} value={editName} onChangeText={setEditName} placeholder="Nombre" placeholderTextColor="#666" />
        <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Grupo / Cliente:</Text>
        <TextInput style={s.input} value={editGrupo} onChangeText={setEditGrupo} placeholder="Sin grupo" placeholderTextColor="#666" />
        {existingGroups.length > 0 && (
          <View style={{flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12}}>
            {existingGroups.map(g => (
              <TouchableOpacity key={g} onPress={() => setEditGrupo(g!)}
                style={{backgroundColor: editGrupo === g ? '#00d4ff' : '#2a2a4a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8, marginBottom: 6}}>
                <Text style={{color: editGrupo === g ? '#1a1a2e' : '#888', fontSize: 12, fontWeight: '600'}}>{g}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <Text style={{color: '#888', fontSize: 12, marginBottom: 4, marginTop: 8}}>FreeDNS - Dominio:</Text>
        <TextInput style={s.input} value={editDnsHost} onChangeText={setEditDnsHost} placeholder="ej: miserver.nuware.com.ar" placeholderTextColor="#666" />
        <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>FreeDNS - URL de update:</Text>
        <TextInput style={[s.input, {fontSize: 12}]} value={editDnsUrl} onChangeText={setEditDnsUrl} placeholder="https://freedns.afraid.org/dynamic/update.php?..." placeholderTextColor="#666" autoCapitalize="none" />
        {editDnsUrl ? (
          <TouchableOpacity
            style={[s.btn, {backgroundColor: '#ff9800', marginBottom: 8}]}
            onPress={() => triggerDnsUpdate(editingMachine.id)}
            disabled={dnsUpdating}>
            <Text style={s.btnTxt}>{dnsUpdating ? 'Actualizando...' : '🌐 Actualizar DNS ahora'}</Text>
          </TouchableOpacity>
        ) : null}
        {editingMachine.dns_last_update && (
          <Text style={{color: '#555', fontSize: 11, textAlign: 'center', marginBottom: 8}}>Ultimo update DNS: {new Date(editingMachine.dns_last_update).toLocaleString()}</Text>
        )}
        <Text style={{color: '#888', fontSize: 12, marginBottom: 4, marginTop: 8}}>Notas:</Text>
        <TextInput
          style={[s.input, {height: 80, textAlignVertical: 'top'}]}
          value={editNotes}
          onChangeText={setEditNotes}
          placeholder="Datos de contacto, contraseñas, observaciones..."
          placeholderTextColor="#666"
          multiline
          numberOfLines={4}
        />
        <TouchableOpacity
          onPress={() => setEditCheckIp(!editCheckIp)}
          style={{flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 16, paddingVertical: 8}}>
          <View style={{width: 22, height: 22, borderWidth: 2, borderColor: editCheckIp ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 10, backgroundColor: editCheckIp ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
            {editCheckIp && <Text style={{color: '#1a1a2e', fontSize: 15, fontWeight: '700'}}>✓</Text>}
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#ddd', fontSize: 14, fontWeight: '600'}}>Monitorear cambio de IP publica</Text>
            <Text style={{color: '#666', fontSize: 11, marginTop: 2}}>Desactiva si la IP es fija para evitar alertas innecesarias</Text>
          </View>
        </TouchableOpacity>
        <Text style={{color: '#ff9800', fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 10}}>Alertas (push notification)</Text>
        <View style={{flexDirection: 'row', marginBottom: 8}}>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>CPU mayor a %</Text>
            <TextInput style={[s.input, {marginBottom: 0, textAlign: 'center'}]} value={editAlertCpu} onChangeText={t => setEditAlertCpu(t.replace(/[^0-9]/g, ''))} placeholder="--" placeholderTextColor="#555" keyboardType="number-pad" maxLength={3} />
          </View>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>RAM mayor a %</Text>
            <TextInput style={[s.input, {marginBottom: 0, textAlign: 'center'}]} value={editAlertRam} onChangeText={t => setEditAlertRam(t.replace(/[^0-9]/g, ''))} placeholder="--" placeholderTextColor="#555" keyboardType="number-pad" maxLength={3} />
          </View>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Disco mayor a %</Text>
            <TextInput style={[s.input, {marginBottom: 0, textAlign: 'center'}]} value={editAlertDisk} onChangeText={t => setEditAlertDisk(t.replace(/[^0-9]/g, ''))} placeholder="--" placeholderTextColor="#555" keyboardType="number-pad" maxLength={3} />
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Ping mayor a ms</Text>
            <TextInput style={[s.input, {marginBottom: 0, textAlign: 'center'}]} value={editAlertPing} onChangeText={t => setEditAlertPing(t.replace(/[^0-9]/g, ''))} placeholder="--" placeholderTextColor="#555" keyboardType="number-pad" maxLength={4} />
          </View>
        </View>
        <Text style={{color: '#666', fontSize: 10, marginBottom: 8}}>Deja vacio para desactivar. Cooldown: 5 min entre alertas.</Text>
        <TouchableOpacity
          onPress={() => setEditAlertOffline(!editAlertOffline)}
          style={{flexDirection: 'row', alignItems: 'center', marginBottom: 16, paddingVertical: 4}}>
          <View style={{width: 22, height: 22, borderWidth: 2, borderColor: editAlertOffline ? '#ff9800' : '#555', borderRadius: 4, marginRight: 10, backgroundColor: editAlertOffline ? '#ff9800' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
            {editAlertOffline && <Text style={{color: '#1a1a2e', fontSize: 15, fontWeight: '700'}}>✓</Text>}
          </View>
          <Text style={{color: '#ddd', fontSize: 14}}>Notificar cuando se desconecte</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btn} onPress={saveEdit}>
          <Text style={s.btnTxt}>Guardar</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setEditingMachine(null)}>
          <Text style={s.link}>Cancelar</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { deleteMachine(editingMachine); setEditingMachine(null); }} style={{marginTop: 20, marginBottom: 30}}>
          <Text style={{color: '#ff5252', textAlign: 'center', fontSize: 14}}>Eliminar maquina</Text>
        </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // HOME
  const onlineCount = machines.filter(m => m.is_online).length;
  const offlineCount = machines.length - onlineCount;

  return (
    <View style={{flex: 1, backgroundColor: '#0a1628'}}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
      {/* Header */}
      <View style={{backgroundColor: '#0d1b2a', paddingTop: 46, paddingHorizontal: 20, paddingBottom: 14}}>
        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <Text style={{fontSize: 28, marginRight: 10}}>{'👁'}</Text>
            <View>
              <Text style={{fontSize: 22, fontWeight: '800'}}><Text style={{color: '#eee'}}>Server</Text><Text style={{color: '#00d4ff'}}>Eyes</Text></Text>
              <Text style={{color: '#607d8b', fontSize: 12}}>{machines.length} maquinas</Text>
            </View>
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <TouchableOpacity onPress={() => loadMachines()} style={{padding: 8}}><Text style={{color: '#607d8b', fontSize: 18}}>{'🔄'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { log.info('Logout'); setAndSaveToken(null); }} style={{padding: 8}}><Text style={{color: '#ff5252', fontSize: 14, fontWeight: '600'}}>Salir</Text></TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Tabs */}
      <View style={{backgroundColor: '#0d1b2a', flexDirection: 'row', paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#1a2a3a'}}>
        {[
          {icon: '🖥', label: 'Servidores', mode: 'all'},
          {icon: '📁', label: '', mode: 'groups'},
          {icon: '👥', label: '', action: async () => { const res = await apiRequest('/api/organization', {}, token); if (res.ok) { setOrgData(res.data); if (res.data.organization) { setOrgName(res.data.organization.name); setOrgAddress(res.data.organization.address || ''); setOrgPhone(res.data.organization.phone || ''); } } setShowTeam(true); }},
          {icon: '📋', label: '', action: () => { setLogText(_logs.slice(-200).reverse().join('\n')); setShowLogs(true); }},
          {icon: '📧', label: '', action: async () => {
            const res = await apiRequest('/api/auth/smtp', {}, token);
            if (res.ok) { setSmtpHost(res.data.smtp_host || ''); setSmtpPort(String(res.data.smtp_port || 587)); setSmtpUser(res.data.smtp_user || ''); setSmtpPass(''); setSmtpFrom(res.data.smtp_from || ''); setSmtpEnabled(res.data.email_notifications !== false); }
            setShowSmtp(true);
          }},
          {icon: '⚙', label: '', action: () => setShowChangePass(true)},
        ].map((tab, i) => (
          <TouchableOpacity key={i} onPress={tab.action || (() => setViewMode(tab.mode as any))}
            style={{paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 2, borderBottomColor: !tab.action && viewMode === tab.mode ? '#00d4ff' : 'transparent'}}>
            <Text style={{color: !tab.action && viewMode === tab.mode ? '#00d4ff' : '#607d8b', fontSize: 14}}>{tab.icon} {tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* IP Alert */}
      {ipAlert && (
        <TouchableOpacity style={{backgroundColor: '#ff9800', padding: 12, flexDirection: 'row', alignItems: 'center'}} onPress={() => setIpAlert(null)}>
          <Text style={{fontSize: 18, marginRight: 8}}>{'🔔'}</Text>
          <View style={{flex: 1}}>
            <Text style={{color: '#1a1a2e', fontWeight: '700', fontSize: 13}}>IP cambio en {ipAlert.name}</Text>
            <Text style={{color: '#1a1a2e', fontSize: 11}}>{ipAlert.oldIp} → {ipAlert.newIp}</Text>
          </View>
          <Text style={{color: '#1a1a2e', fontSize: 16}}>✕</Text>
        </TouchableOpacity>
      )}

      {/* Machine list */}
      {viewMode === 'groups' ? (
        <FlatList data={[1]} keyExtractor={() => 'groups'} renderItem={() => renderGroupView()} onRefresh={() => loadMachines()} refreshing={false} />
      ) : (
        <FlatList
          data={machines}
          keyExtractor={i => i.id.toString()}
          contentContainerStyle={{padding: 12, paddingBottom: 90}}
          onRefresh={() => loadMachines()}
          refreshing={false}
          ListEmptyComponent={
            <View style={{alignItems: 'center', marginTop: 100}}>
              <Text style={{fontSize: 60}}>{'🖥'}</Text>
              <Text style={{color: '#607d8b', fontSize: 18, marginTop: 16}}>No hay maquinas</Text>
              <Text style={{color: '#3a5068', fontSize: 14, marginTop: 4}}>Toca + para agregar</Text>
            </View>
          }
          renderItem={({item}) => renderMachineCard(item)}
        />
      )}

      {/* FABs */}
      <TouchableOpacity style={{position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8}} onPress={() => setShowAdd(true)}>
        <Text style={{fontSize: 28, color: '#0a1628', fontWeight: '700'}}>+</Text>
      </TouchableOpacity>
      <TouchableOpacity style={{position: 'absolute', bottom: 24, right: 90, width: 56, height: 56, borderRadius: 28, backgroundColor: '#1a2a3a', alignItems: 'center', justifyContent: 'center', elevation: 8}} onPress={() => setShowPairing(true)}>
        <Text style={{fontSize: 22}}>{'🔗'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a1628', justifyContent: 'center', padding: 24 },
  icon: { fontSize: 60, textAlign: 'center', marginBottom: 10 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#00d4ff', textAlign: 'center' },
  sub: { fontSize: 14, color: '#607d8b', textAlign: 'center', marginTop: 4, marginBottom: 20 },
  input: { backgroundColor: '#0d1b2a', borderWidth: 2, borderColor: '#1a2a3a', borderRadius: 12, padding: 14, fontSize: 16, color: '#eee', marginBottom: 12 },
  btn: { backgroundColor: '#00d4ff', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnTxt: { fontSize: 16, fontWeight: '700', color: '#0a1628' },
  err: { color: '#ff5252', textAlign: 'center', fontSize: 13, marginBottom: 8 },
  link: { color: '#00d4ff', textAlign: 'center', marginTop: 16, fontSize: 14 },
  key: { backgroundColor: '#0d1b2a', borderRadius: 8, padding: 14, fontSize: 15, color: '#00d4ff', textAlign: 'center', marginVertical: 16, fontFamily: 'monospace' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, backgroundColor: '#0d1b2a' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#00d4ff' },
  logoutBtn: { backgroundColor: '#1a2a3a', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  card: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabTxt: { fontSize: 30, color: '#0a1628', fontWeight: '700', marginTop: -2 },
});
