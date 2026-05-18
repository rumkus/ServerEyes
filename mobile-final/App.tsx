import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, Alert, StatusBar, Vibration, Share, ScrollView, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import RNShare from 'react-native-share';
import messaging from '@react-native-firebase/messaging';
import { Platform, PermissionsAndroid } from 'react-native';

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
  const [dnsUpdating, setDnsUpdating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logText, setLogText] = useState('');
  const [showChangePass, setShowChangePass] = useState(false);
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
  const [newGroupName, setNewGroupName] = useState('');

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
    if (t) await AsyncStorage.setItem('servereyes_token', t);
    else await AsyncStorage.removeItem('servereyes_token');
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
      check_ip_change: editCheckIp
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

  // Render de una maquina
  const renderMachineCard = (item: any) => (
    <TouchableOpacity
      key={item.id}
      style={[s.card, item.is_online ? {backgroundColor: '#0d2818', borderColor: '#1a5c2e'} : {backgroundColor: '#2d1117', borderColor: '#5c1a1a'}]}
      onPress={() => { setEditingMachine(item); setEditName(item.machine_name); setEditGrupo(item.grupo || ''); setEditDnsUrl(item.dns_update_url || ''); setEditDnsHost(item.dns_host || ''); setEditCheckIp(item.check_ip_change !== false); }}
      onLongPress={() => deleteMachine(item)}>
      <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
        <View style={{width: 10, height: 10, borderRadius: 5, marginRight: 8, backgroundColor: item.is_online ? '#00e676' : '#ff5252'}} />
        <Text style={{flex: 1, fontSize: 18, fontWeight: '700', color: '#eee'}}>{item.machine_name}</Text>
        <Text style={{fontSize: 12, fontWeight: '700', color: item.is_online ? '#00e676' : '#ff5252'}}>
          {item.is_online ? 'ONLINE' : 'OFFLINE'}
        </Text>
      </View>
      {item.grupo && <Text style={{color: '#00d4ff', fontSize: 11, marginBottom: 4}}>📁 {item.grupo}</Text>}
      {item.dns_host && <Text style={{color: '#ff9800', fontSize: 11, marginBottom: 6}}>🌐 {item.dns_host}</Text>}
      {item.check_ip_change === false && <Text style={{color: '#666', fontSize: 11, marginBottom: 6}}>🔕 Monitoreo de IP desactivado</Text>}
      <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
        <Text style={{color: '#888', fontSize: 13}}>IP Publica:</Text>
        <Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{item.public_ip || '---'}</Text>
      </View>
      <View style={{marginBottom: 4}}>
        <Text style={{color: '#888', fontSize: 13, marginBottom: 2}}>IP Local:</Text>
        {(item.local_ip || '---').split(' | ').map((ip: string, i: number) => (
          <Text key={i} style={{color: '#ddd', fontSize: 13, fontWeight: '600', paddingLeft: 8}}>{ip.trim()}</Text>
        ))}
      </View>
      <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
        <Text style={{color: '#888', fontSize: 13}}>Heartbeat:</Text>
        <Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{timeSince(item.last_heartbeat)}</Text>
      </View>
      <View style={{flexDirection: 'row', justifyContent: 'space-between', marginTop: 4}}>
        <Text style={{color: '#888', fontSize: 13}}>Ping:</Text>
        <Text style={{color: item.ping_ms ? (item.ping_ms < 50 ? '#00e676' : item.ping_ms < 150 ? '#ff9800' : '#ff5252') : '#555', fontSize: 13, fontWeight: '600'}}>
          {item.ping_ms ? `${item.ping_ms}ms` : '---'}
        </Text>
      </View>
      {item.download_mbps && (
        <View style={{flexDirection: 'row', justifyContent: 'space-between', marginTop: 4}}>
          <Text style={{color: '#888', fontSize: 13}}>Velocidad:</Text>
          <Text style={{color: '#00d4ff', fontSize: 13, fontWeight: '600'}}>{item.download_mbps} Mbps</Text>
        </View>
      )}
      {item.os_info && <Text style={{color: '#555', fontSize: 11, marginTop: 6}}>{item.os_info}</Text>}
      <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8}}>
        <View style={{flexDirection: 'row'}}>
          <TouchableOpacity onPress={() => openUptime(item)} style={{padding: 6, marginRight: 12}}>
            <Text style={{color: '#00d4ff', fontSize: 12}}>📊 Uptime</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => {
            const res = await apiRequest(`/api/machines/${item.id}/speedtest`, { method: 'POST' }, token);
            if (res.ok) Alert.alert('Speed Test', 'Solicitado. El resultado aparece en ~30 segundos.');
          }} style={{padding: 6}}>
            <Text style={{color: '#ff9800', fontSize: 12}}>⚡ Speed Test</Text>
          </TouchableOpacity>
        </View>
        <View style={{flexDirection: 'row'}}>
          <TouchableOpacity onPress={() => moveMachineUp(item)} style={{padding: 6}}>
            <Text style={{color: '#555', fontSize: 16}}>▲</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => moveMachineDown(item)} style={{padding: 6, marginLeft: 8}}>
            <Text style={{color: '#555', fontSize: 16}}>▼</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );

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

  // EDIT MODAL
  if (editingMachine) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
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
        <TouchableOpacity
          onPress={() => setEditCheckIp(!editCheckIp)}
          style={{flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 16, paddingVertical: 8}}>
          <View style={{width: 22, height: 22, borderWidth: 2, borderColor: editCheckIp ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 10, backgroundColor: editCheckIp ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
            {editCheckIp && <Text style={{color: '#1a1a2e', fontSize: 15, fontWeight: '700'}}>✓</Text>}
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#ddd', fontSize: 14, fontWeight: '600'}}>Monitorear cambio de IP publica</Text>
            <Text style={{color: '#666', fontSize: 11, marginTop: 2}}>Desactiva si la IP es fija para evitar alertas innecesarias</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={s.btn} onPress={saveEdit}>
          <Text style={s.btnTxt}>Guardar</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setEditingMachine(null)}>
          <Text style={s.link}>Cancelar</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { deleteMachine(editingMachine); setEditingMachine(null); }} style={{marginTop: 20}}>
          <Text style={{color: '#ff5252', textAlign: 'center', fontSize: 14}}>Eliminar maquina</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // HOME
  return (
    <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
      <StatusBar barStyle="light-content" backgroundColor="#16213e" />
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>👁 ServerEyes</Text>
          <Text style={{color: '#888', fontSize: 13}}>{machines.length} maquinas</Text>
        </View>
        <View style={{flexDirection: 'row', alignItems: 'center'}}>
          <TouchableOpacity
            onPress={() => setViewMode(viewMode === 'all' ? 'groups' : 'all')}
            style={{backgroundColor: '#2a2a4a', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginRight: 8}}>
            <Text style={{color: '#00d4ff', fontSize: 13}}>{viewMode === 'all' ? '📁' : '📋'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setLogText(_logs.slice(-200).reverse().join('\n')); setShowLogs(true); }}
            style={{backgroundColor: '#2a2a4a', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginRight: 8}}>
            <Text style={{color: '#888', fontSize: 13}}>📋</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowChangePass(true)}
            style={{backgroundColor: '#2a2a4a', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginRight: 8}}>
            <Text style={{color: '#888', fontSize: 13}}>🔒</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.logoutBtn} onPress={() => { log.info('Logout'); setAndSaveToken(null); }}>
            <Text style={{color: '#ff5252', fontWeight: '600'}}>Salir</Text>
          </TouchableOpacity>
        </View>
      </View>

      {ipAlert && (
        <TouchableOpacity
          style={{backgroundColor: '#ff9800', padding: 14, flexDirection: 'row', alignItems: 'center'}}
          onPress={() => setIpAlert(null)}>
          <Text style={{fontSize: 20, marginRight: 10}}>🔔</Text>
          <View style={{flex: 1}}>
            <Text style={{color: '#1a1a2e', fontWeight: '700', fontSize: 14}}>IP cambio en {ipAlert.name}</Text>
            <Text style={{color: '#1a1a2e', fontSize: 12}}>{ipAlert.oldIp} → {ipAlert.newIp}</Text>
          </View>
          <Text style={{color: '#1a1a2e', fontSize: 18}}>✕</Text>
        </TouchableOpacity>
      )}

      {viewMode === 'groups' ? (
        <FlatList
          data={[1]}
          keyExtractor={() => 'groups'}
          renderItem={() => renderGroupView()}
          onRefresh={() => loadMachines()}
          refreshing={false}
        />
      ) : (
        <FlatList
          data={machines}
          keyExtractor={i => i.id.toString()}
          contentContainerStyle={{padding: 16, paddingBottom: 80}}
          onRefresh={() => loadMachines()}
          refreshing={false}
          ListEmptyComponent={
            <View style={{alignItems: 'center', marginTop: 100}}>
              <Text style={{fontSize: 60}}>🖥</Text>
              <Text style={{color: '#888', fontSize: 18, marginTop: 16}}>No hay maquinas</Text>
              <Text style={{color: '#555', fontSize: 14, marginTop: 4}}>Toca + para agregar</Text>
            </View>
          }
          renderItem={({item}) => renderMachineCard(item)}
        />
      )}

      <TouchableOpacity style={[s.fab, {bottom: 90, backgroundColor: '#2a2a4a'}]} onPress={() => setShowAdd(true)}>
        <Text style={[s.fabTxt, {fontSize: 22, color: '#00d4ff'}]}>+</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.fab} onPress={() => setShowPairing(true)}>
        <Text style={[s.fabTxt, {fontSize: 20}]}>🔗</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', padding: 24 },
  icon: { fontSize: 60, textAlign: 'center', marginBottom: 10 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#00d4ff', textAlign: 'center' },
  sub: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 4, marginBottom: 20 },
  input: { backgroundColor: '#16213e', borderWidth: 2, borderColor: '#2a2a4a', borderRadius: 12, padding: 14, fontSize: 16, color: '#eee', marginBottom: 12 },
  btn: { backgroundColor: '#00d4ff', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnTxt: { fontSize: 16, fontWeight: '700', color: '#1a1a2e' },
  err: { color: '#ff5252', textAlign: 'center', fontSize: 13, marginBottom: 8 },
  link: { color: '#00d4ff', textAlign: 'center', marginTop: 16, fontSize: 14 },
  key: { backgroundColor: '#16213e', borderRadius: 8, padding: 14, fontSize: 15, color: '#00d4ff', textAlign: 'center', marginVertical: 16, fontFamily: 'monospace' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, backgroundColor: '#16213e' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#00d4ff' },
  logoutBtn: { backgroundColor: '#2a2a4a', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  card: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabTxt: { fontSize: 30, color: '#1a1a2e', fontWeight: '700', marginTop: -2 },
});
