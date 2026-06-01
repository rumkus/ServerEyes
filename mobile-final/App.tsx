import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, Alert, StatusBar, Vibration, Share, ScrollView, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import RNShare from 'react-native-share';
import messaging from '@react-native-firebase/messaging';
import { Platform, PermissionsAndroid, NativeModules, BackHandler } from 'react-native';
const { WidgetBridge } = NativeModules;

const API_URL = 'https://servereyes-production.up.railway.app';

// i18n
const LANGS: {[k:string]: {name:string, flag:string, [k:string]:string}} = {
  es: { name: 'Español', flag: '🇪🇸', login_title: 'Iniciar sesion', login_btn: 'Iniciar sesion', create_account: 'Crear cuenta', have_account: 'Ya tengo cuenta', new_account: 'Crear cuenta nueva', show_password: 'Ver contraseña', fill_fields: 'Completa todos los campos', logout: 'Salir', machines_count: 'maquinas', search: 'Buscar...', save: 'Guardar', cancel: 'Cancelar', close: 'Cerrar', back: 'Volver', language: 'Idioma', uptime: 'Uptime', metrics: 'Metricas', ips: 'IPs', disks: 'Discos', logs: 'Logs', services: 'Servicios', config: 'Config', backup: 'Backup', edit: 'Editar', change_pass: 'Cambiar contraseña', current_pass: 'Contraseña actual', new_pass: 'Nueva contraseña (min 6 caracteres)', pass_updated: 'Contraseña actualizada', email_config: 'Configurar Email', email_notif: 'Recibir notificaciones por email', smtp_host: 'Host SMTP (vacio para Gmail)', smtp_port: 'Puerto', smtp_user: 'Email SMTP', smtp_pass: 'Contraseña SMTP', smtp_from: 'Remitente (opcional)', smtp_test: 'Enviar email de prueba', smtp_hint: 'Para Gmail: deja Host vacio, usa tu email y una contraseña de aplicacion', team: 'Empresa y Equipo', force_check: 'Forzar chequeo', check_requested: 'Resultado en ~30 segundos', backup_date: 'Ultima fecha del backup', checked_at: 'Chequeado', share_machines: 'Compartir maquinas', select_machines: 'Selecciona las maquinas que este tecnico podra ver', invite_tech: 'Invitar tecnico', join_team: 'Te invitaron a un equipo?', join_btn: 'Unirme', create_company: 'Crear empresa', company_name: 'Nombre de la empresa', ip_history: 'Historial de IPs', current_ip: 'IP actual', no_changes: 'Sin cambios de IP registrados' },
  en: { name: 'English', flag: '🇺🇸', login_title: 'Sign in', login_btn: 'Sign in', create_account: 'Create account', have_account: 'Already have an account', new_account: 'Create new account', show_password: 'Show password', fill_fields: 'Fill all fields', logout: 'Logout', machines_count: 'machines', search: 'Search...', save: 'Save', cancel: 'Cancel', close: 'Close', back: 'Back', language: 'Language', uptime: 'Uptime', metrics: 'Metrics', ips: 'IPs', disks: 'Disks', logs: 'Logs', services: 'Services', config: 'Config', backup: 'Backup', edit: 'Edit', change_pass: 'Change password', current_pass: 'Current password', new_pass: 'New password (min 6 characters)', pass_updated: 'Password updated', email_config: 'Configure Email', email_notif: 'Receive email notifications', smtp_host: 'SMTP Host (empty for Gmail)', smtp_port: 'Port', smtp_user: 'SMTP Email', smtp_pass: 'SMTP Password', smtp_from: 'Sender (optional)', smtp_test: 'Send test email', smtp_hint: 'For Gmail: leave Host empty, use your email and an app password', team: 'Company & Team', force_check: 'Force check', check_requested: 'Result in ~30 seconds', backup_date: 'Last backup date', checked_at: 'Checked', share_machines: 'Share machines', select_machines: 'Select machines this technician can see', invite_tech: 'Invite technician', join_team: 'Were you invited to a team?', join_btn: 'Join', create_company: 'Create company', company_name: 'Company name', ip_history: 'IP History', current_ip: 'Current IP', no_changes: 'No IP changes recorded' },
};
let _currentLang = 'es';
const t = (key: string) => (LANGS[_currentLang] && LANGS[_currentLang][key]) || LANGS.es[key] || key;
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
  const [lang, setLang] = useState('es');
  const changeLang = async (l: string) => { _currentLang = l; setLang(l); await AsyncStorage.setItem('se_lang', l); };
  const [menuOpen, setMenuOpen] = useState(false);
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
  const [backupMachine, setBackupMachine] = useState<any>(null);
  const [backupData, setBackupData] = useState<any>(null);
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
  const [showUrlMonitors, setShowUrlMonitors] = useState(false);
  const [urlMonitors, setUrlMonitors] = useState<any[]>([]);
  const [showAddUrl, setShowAddUrl] = useState(false);
  const [urlName, setUrlName] = useState('');
  const [urlUrl, setUrlUrl] = useState('');
  const [urlMethod, setUrlMethod] = useState('GET');
  const [urlExpectedStatus, setUrlExpectedStatus] = useState('200');
  const [urlTimeout, setUrlTimeout] = useState('10000');
  const [urlInterval, setUrlInterval] = useState('300');
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [maintenanceWindows, setMaintenanceWindows] = useState<any[]>([]);
  const [showAddMaintenance, setShowAddMaintenance] = useState(false);
  const [mwTitle, setMwTitle] = useState('Mantenimiento');
  const [mwMachineId, setMwMachineId] = useState('');
  const [mwStartDate, setMwStartDate] = useState('');
  const [mwStartTime, setMwStartTime] = useState('');
  const [mwEndDate, setMwEndDate] = useState('');
  const [mwEndTime, setMwEndTime] = useState('');
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [editMac, setEditMac] = useState('');
  const [editWolBroadcast, setEditWolBroadcast] = useState('255.255.255.255');
  const [editGeoCity, setEditGeoCity] = useState('');
  const [editGeoRegion, setEditGeoRegion] = useState('');
  const [editGeoCountry, setEditGeoCountry] = useState('');
  const [editGeoLat, setEditGeoLat] = useState('');
  const [editGeoLon, setEditGeoLon] = useState('');
  const [geoSearchAddr, setGeoSearchAddr] = useState('');
  const [geoSearching, setGeoSearching] = useState(false);
  const [geoSearchResult, setGeoSearchResult] = useState('');

  // Funcion para volver a la pantalla principal
  const goBack = (): boolean => {
    if (menuOpen) { setMenuOpen(false); return true; }
    if (showAddUrl) { setShowAddUrl(false); return true; }
    if (showAddMaintenance) { setShowAddMaintenance(false); return true; }
    if (showUrlMonitors) { setShowUrlMonitors(false); return true; }
    if (showMaintenance) { setShowMaintenance(false); return true; }
    if (showAuditLog) { setShowAuditLog(false); return true; }
    if (backupMachine) { setBackupMachine(null); return true; }
    if (shareUserId) { setShareUserId(null); return true; }
    if (detailMachine) { setDetailMachine(null); return true; }
    if (showTeam) { setShowTeam(false); return true; }
    if (showAgentUpdate) { setShowAgentUpdate(false); return true; }
    if (showSmtp) { setShowSmtp(false); return true; }
    if (showChangePass) { setShowChangePass(false); setCurrentPass(''); setNewPass(''); return true; }
    if (showLogs) { setShowLogs(false); return true; }
    if (showPairing) { setShowPairing(false); setPairingCode(''); return true; }
    if (showAdd) { setShowAdd(false); setNewKey(''); return true; }
    if (editingMachine) { setEditingMachine(null); return true; }
    if (showGroupPicker) { setShowGroupPicker(null); return true; }
    if (uptimeMachine) { setUptimeMachine(null); return true; }
    if (metricsMachine) { setMetricsMachine(null); return true; }
    if (ipHistoryMachine) { setIpHistoryMachine(null); return true; }
    return false;
  };

  // BackHandler de Android (boton atras / gesto deslizar)
  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => handler.remove();
  });

  // Header con flecha de volver
  const BackHeader = ({title, subtitle}: {title: string, subtitle?: string}) => (
    <View style={{backgroundColor: '#0d1b2a', paddingTop: 46, paddingHorizontal: 16, paddingBottom: 14, flexDirection: 'row', alignItems: 'center'}}>
      <TouchableOpacity onPress={() => goBack()} style={{padding: 8, marginRight: 8}}>
        <Text style={{color: '#607d8b', fontSize: 24}}>{'←'}</Text>
      </TouchableOpacity>
      <View style={{flex: 1}}>
        <Text style={{fontSize: 18, fontWeight: '700', color: '#00d4ff'}}>{title}</Text>
        {subtitle ? <Text style={{color: '#607d8b', fontSize: 12}}>{subtitle}</Text> : null}
      </View>
    </View>
  );

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
    AsyncStorage.getItem('se_lang').then(saved => { if (saved && LANGS[saved]) { _currentLang = saved; setLang(saved); } });
    loadLogs().then(() => {
      log.info('Logs cargados');
      AsyncStorage.getItem('servereyes_token').then(saved => {
        if (saved) {
          log.info('Token encontrado en storage');
          setToken(saved);
          try { WidgetBridge?.setToken(saved); } catch {}
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
        try { WidgetBridge?.refreshWidget(); } catch {}
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

  const geocodeAddress = async () => {
    const q = geoSearchAddr.trim();
    if (!q) return;
    setGeoSearching(true);
    setGeoSearchResult('');
    try {
      const coordMatch = q.match(/^[^\d]*(-?\d+[.,]\d+)\s*[,;\s]\s*(-?\d+[.,]\d+)\s*$/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1].replace(',','.')).toFixed(6);
        const lon = parseFloat(coordMatch[2].replace(',','.')).toFixed(6);
        const rr = await fetch('https://photon.komoot.io/reverse?lon='+lon+'&lat='+lat+'&lang=es');
        const rj = await rr.json();
        const p = rj.features?.[0]?.properties || {};
        setEditGeoCity(p.city||p.town||p.village||p.district||'');
        setEditGeoRegion(p.state||'');
        setEditGeoCountry(p.country||'');
        setEditGeoLat(lat); setEditGeoLon(lon);
        setGeoSearchResult([p.name,p.city||p.town||p.village,p.state,p.country].filter(Boolean).join(', ')||lat+', '+lon);
        return;
      }
      const clean = q.replace(/\b[A-Z]\d{4}\b/g, '').replace(/\s+/g,' ').trim();
      const fillFromDatos = (d: any) => {
        setEditGeoCity(d.localidad_censal?.nombre||d.departamento?.nombre||'');
        setEditGeoRegion(d.provincia?.nombre||'');
        setEditGeoCountry('Argentina');
        setEditGeoLat(parseFloat(d.ubicacion.lat).toFixed(6));
        setEditGeoLon(parseFloat(d.ubicacion.lon).toFixed(6));
        setGeoSearchResult(d.nomenclatura + ', ' + (d.localidad_censal?.nombre||'') + ', ' + (d.provincia?.nombre||''));
      };
      const tryDatos = async (qs: string) => {
        const r = await fetch('https://apis.datos.gob.ar/georef/api/direcciones?' + qs + '&max=5');
        const rj = await r.json();
        const dirs = rj.direcciones || [];
        if (dirs.length > 0 && dirs[0].ubicacion?.lat) { fillFromDatos(dirs[0]); return true; }
        return false;
      };
      if (await tryDatos('direccion=' + encodeURIComponent(clean))) return;
      const splitMatch = clean.match(/^(.+?\s+\d+)\s*[,.]?\s+(.+)$/);
      if (splitMatch) {
        const calle = splitMatch[1].trim();
        const resto = splitMatch[2].trim();
        const parts = resto.split(/\s*,\s*/);
        let qs = 'direccion=' + encodeURIComponent(calle) + '&localidad=' + encodeURIComponent(parts[0]);
        if (parts[1]) qs += '&provincia=' + encodeURIComponent(parts[1]);
        if (await tryDatos(qs)) return;
      }
      const r2 = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(clean + (clean.toLowerCase().includes('argentin')?'':', argentina')) + '&limit=5&lang=es');
      const rj2 = await r2.json();
      const features = rj2.features || [];
      if (features.length === 0) { setGeoSearchResult('No se encontro la direccion.'); return; }
      const f = features[0];
      const p = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      setEditGeoCity(p.city||p.town||p.village||p.district||'');
      setEditGeoRegion(p.state||'');
      setEditGeoCountry(p.country||'');
      setEditGeoLat(parseFloat(coords[1]).toFixed(6));
      setEditGeoLon(parseFloat(coords[0]).toFixed(6));
      setGeoSearchResult([p.name,p.street,p.city||p.town||p.village,p.state,p.country].filter(Boolean).join(', '));
    } catch (e: any) { setGeoSearchResult('Error: ' + e.message); }
    finally { setGeoSearching(false); }
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
      alert_offline: editAlertOffline,
      mac_address: editMac || null,
      wol_broadcast: editWolBroadcast || '255.255.255.255',
      geo_city: editGeoCity || null,
      geo_region: editGeoRegion || null,
      geo_country: editGeoCountry || null,
      geo_lat: editGeoLat ? parseFloat(editGeoLat) : null,
      geo_lon: editGeoLon ? parseFloat(editGeoLon) : null
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

  // URL MONITORS
  const loadUrlMonitors = async () => {
    const res = await apiRequest('/api/url-monitors', {}, token);
    if (res.ok) setUrlMonitors(res.data);
  };

  if (showAddUrl) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Agregar Monitor URL" />
        <ScrollView contentContainerStyle={{padding: 24}}>
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>URL:</Text>
          <TextInput style={s.input} value={urlUrl} onChangeText={setUrlUrl} placeholder="https://ejemplo.com" placeholderTextColor="#555" autoCapitalize="none" keyboardType="url" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Nombre (opcional):</Text>
          <TextInput style={s.input} value={urlName} onChangeText={setUrlName} placeholder="Mi sitio web" placeholderTextColor="#555" />
          <View style={{flexDirection: 'row', marginBottom: 8}}>
            <View style={{flex: 1, marginRight: 6}}>
              <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Metodo</Text>
              <View style={{flexDirection: 'row'}}>
                {['GET', 'HEAD', 'POST'].map(m => (
                  <TouchableOpacity key={m} onPress={() => setUrlMethod(m)}
                    style={{backgroundColor: urlMethod === m ? '#00d4ff' : '#1a2a3a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6}}>
                    <Text style={{color: urlMethod === m ? '#0a1628' : '#607d8b', fontWeight: '600', fontSize: 13}}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={{flex: 1}}>
              <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Status esperado</Text>
              <TextInput style={[s.input, {marginBottom: 0}]} value={urlExpectedStatus} onChangeText={setUrlExpectedStatus} keyboardType="number-pad" placeholderTextColor="#555" />
            </View>
          </View>
          <View style={{flexDirection: 'row', marginBottom: 12}}>
            <View style={{flex: 1, marginRight: 6}}>
              <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Timeout (ms)</Text>
              <TextInput style={[s.input, {marginBottom: 0}]} value={urlTimeout} onChangeText={setUrlTimeout} keyboardType="number-pad" placeholderTextColor="#555" />
            </View>
            <View style={{flex: 1}}>
              <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Intervalo (seg)</Text>
              <TextInput style={[s.input, {marginBottom: 0}]} value={urlInterval} onChangeText={setUrlInterval} keyboardType="number-pad" placeholderTextColor="#555" />
            </View>
          </View>
          <TouchableOpacity style={s.btn} onPress={async () => {
            if (!urlUrl.trim()) { Alert.alert('Error', 'URL requerida'); return; }
            const res = await apiRequest('/api/url-monitors', { method: 'POST', body: JSON.stringify({
              url: urlUrl.trim(), name: urlName.trim() || null, method: urlMethod,
              expected_status: parseInt(urlExpectedStatus) || 200,
              timeout_ms: parseInt(urlTimeout) || 10000,
              interval_seconds: parseInt(urlInterval) || 300
            }) }, token);
            if (res.ok) { setShowAddUrl(false); setUrlUrl(''); setUrlName(''); loadUrlMonitors(); }
            else Alert.alert('Error', res.data?.error || 'Error');
          }}>
            <Text style={s.btnTxt}>Agregar monitor</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowAddUrl(false)}><Text style={s.link}>Cancelar</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (showUrlMonitors) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Monitoreo de URLs" subtitle={`${urlMonitors.length} monitores`} />
        <ScrollView contentContainerStyle={{padding: 16, paddingBottom: 100}}>
          {urlMonitors.length === 0 ? (
            <View style={{alignItems: 'center', paddingVertical: 60}}>
              <Text style={{fontSize: 48, marginBottom: 12}}>🌐</Text>
              <Text style={{color: '#607d8b', fontSize: 16}}>Sin monitores configurados</Text>
              <Text style={{color: '#3a5068', fontSize: 13, marginTop: 4}}>Agrega una URL para empezar</Text>
            </View>
          ) : urlMonitors.map((u: any) => (
            <View key={u.id} style={{backgroundColor: '#0d1b2a', borderRadius: 14, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: u.is_up ? '#00e676' : '#ff5252', overflow: 'hidden'}}>
              <View style={{padding: 14}}>
                <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 6}}>
                  <View style={{width: 10, height: 10, borderRadius: 5, backgroundColor: u.is_up ? '#00e676' : '#ff5252', marginRight: 10}} />
                  <Text style={{flex: 1, fontSize: 16, fontWeight: '700', color: '#eee'}}>{u.name || u.url}</Text>
                  <View style={{backgroundColor: u.is_up ? '#0d2818' : '#2d1117', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6}}>
                    <Text style={{fontSize: 11, fontWeight: '700', color: u.is_up ? '#00e676' : '#ff5252'}}>{u.is_up ? 'UP' : 'DOWN'}</Text>
                  </View>
                </View>
                <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}} numberOfLines={1}>{u.url}</Text>
                <View style={{flexDirection: 'row', marginTop: 4}}>
                  <Text style={{color: '#888', fontSize: 12, marginRight: 14}}>{u.method || 'GET'}</Text>
                  {u.last_response_ms != null && <Text style={{color: u.last_response_ms < 500 ? '#00e676' : u.last_response_ms < 2000 ? '#ff9800' : '#ff5252', fontSize: 12, fontWeight: '600', marginRight: 14}}>{u.last_response_ms}ms</Text>}
                  {u.last_status && <Text style={{color: u.last_status === (u.expected_status || 200) ? '#00e676' : '#ff5252', fontSize: 12}}>HTTP {u.last_status}</Text>}
                  <Text style={{color: '#555', fontSize: 12, marginLeft: 'auto'}}>{u.last_check ? timeSince(u.last_check) : 'Nunca'}</Text>
                </View>
                {u.last_error && <Text style={{color: '#ff5252', fontSize: 11, marginTop: 4}}>{u.last_error}</Text>}
              </View>
              <View style={{flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1a2a3a'}}>
                <TouchableOpacity style={{flex: 1, paddingVertical: 10, alignItems: 'center'}} onPress={async () => {
                  await apiRequest(`/api/url-monitors/${u.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !u.is_active }) }, token);
                  loadUrlMonitors();
                }}>
                  <Text style={{color: u.is_active ? '#ff9800' : '#00e676', fontSize: 12, fontWeight: '600'}}>{u.is_active ? '⏸ Pausar' : '▶ Activar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{flex: 1, paddingVertical: 10, alignItems: 'center', borderLeftWidth: 1, borderLeftColor: '#1a2a3a'}} onPress={() => {
                  Alert.alert('Eliminar', `¿Eliminar monitor "${u.name || u.url}"?`, [
                    { text: 'No' },
                    { text: 'Si', style: 'destructive', onPress: async () => {
                      await apiRequest(`/api/url-monitors/${u.id}`, { method: 'DELETE' }, token);
                      loadUrlMonitors();
                    }}
                  ]);
                }}>
                  <Text style={{color: '#ff5252', fontSize: 12, fontWeight: '600'}}>🗑 Eliminar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
        <TouchableOpacity style={{position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8}}
          onPress={() => { setUrlUrl(''); setUrlName(''); setUrlMethod('GET'); setUrlExpectedStatus('200'); setUrlTimeout('10000'); setUrlInterval('300'); setShowAddUrl(true); }}>
          <Text style={{fontSize: 28, color: '#0a1628', fontWeight: '700'}}>+</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // MAINTENANCE WINDOWS
  const loadMaintenanceWindows = async () => {
    const res = await apiRequest('/api/maintenance', {}, token);
    if (res.ok) setMaintenanceWindows(res.data);
  };

  if (showAddMaintenance) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Nueva Ventana" subtitle="Mantenimiento programado" />
        <ScrollView contentContainerStyle={{padding: 24}}>
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Titulo:</Text>
          <TextInput style={s.input} value={mwTitle} onChangeText={setMwTitle} placeholder="Reboot nocturno" placeholderTextColor="#555" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Maquina (vacio = todas):</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom: 12}}>
            <TouchableOpacity onPress={() => setMwMachineId('')}
              style={{backgroundColor: !mwMachineId ? '#00d4ff' : '#1a2a3a', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8}}>
              <Text style={{color: !mwMachineId ? '#0a1628' : '#607d8b', fontWeight: '600', fontSize: 13}}>Todas</Text>
            </TouchableOpacity>
            {machines.map(m => (
              <TouchableOpacity key={m.id} onPress={() => setMwMachineId(String(m.id))}
                style={{backgroundColor: mwMachineId === String(m.id) ? '#00d4ff' : '#1a2a3a', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8}}>
                <Text style={{color: mwMachineId === String(m.id) ? '#0a1628' : '#607d8b', fontWeight: '600', fontSize: 13}}>{m.machine_name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Inicio (fecha YYYY-MM-DD):</Text>
          <TextInput style={s.input} value={mwStartDate} onChangeText={setMwStartDate} placeholder="2026-05-30" placeholderTextColor="#555" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Inicio (hora HH:MM):</Text>
          <TextInput style={s.input} value={mwStartTime} onChangeText={setMwStartTime} placeholder="22:00" placeholderTextColor="#555" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Fin (fecha YYYY-MM-DD):</Text>
          <TextInput style={s.input} value={mwEndDate} onChangeText={setMwEndDate} placeholder="2026-05-31" placeholderTextColor="#555" />
          <Text style={{color: '#888', fontSize: 12, marginBottom: 4}}>Fin (hora HH:MM):</Text>
          <TextInput style={s.input} value={mwEndTime} onChangeText={setMwEndTime} placeholder="06:00" placeholderTextColor="#555" />
          <Text style={{color: '#607d8b', fontSize: 11, marginBottom: 16}}>Las alertas se silencian durante esta ventana.</Text>
          <TouchableOpacity style={s.btn} onPress={async () => {
            const startStr = `${mwStartDate}T${mwStartTime}:00`;
            const endStr = `${mwEndDate}T${mwEndTime}:00`;
            if (!mwStartDate || !mwStartTime || !mwEndDate || !mwEndTime) { Alert.alert('Error', 'Completa fecha y hora'); return; }
            const res = await apiRequest('/api/maintenance', { method: 'POST', body: JSON.stringify({
              machine_id: mwMachineId ? parseInt(mwMachineId) : null,
              title: mwTitle || 'Mantenimiento',
              start_time: startStr, end_time: endStr
            }) }, token);
            if (res.ok) { setShowAddMaintenance(false); loadMaintenanceWindows(); }
            else Alert.alert('Error', res.data?.error || 'Error');
          }}>
            <Text style={s.btnTxt}>Crear ventana</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowAddMaintenance(false)}><Text style={s.link}>Cancelar</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (showMaintenance) {
    const now = new Date();
    const active = maintenanceWindows.filter((w: any) => new Date(w.start_time) <= now && new Date(w.end_time) >= now);
    const upcoming = maintenanceWindows.filter((w: any) => new Date(w.start_time) > now);
    const past = maintenanceWindows.filter((w: any) => new Date(w.end_time) < now).slice(0, 10);

    const fmtDate = (ts: string) => new Date(ts).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Mantenimiento" subtitle={`${maintenanceWindows.length} ventanas`} />
        <ScrollView contentContainerStyle={{padding: 16, paddingBottom: 100}}>
          {active.length > 0 && (
            <>
              <Text style={{color: '#ff9800', fontSize: 14, fontWeight: '700', marginBottom: 8}}>🔧 Activas ahora</Text>
              {active.map((w: any) => (
                <View key={w.id} style={{backgroundColor: '#1a1500', borderLeftWidth: 3, borderLeftColor: '#ff9800', borderRadius: 12, padding: 14, marginBottom: 8}}>
                  <Text style={{color: '#eee', fontSize: 15, fontWeight: '700'}}>{w.title}</Text>
                  <Text style={{color: '#888', fontSize: 12, marginTop: 4}}>{w.machine_name || 'Todas'} · {fmtDate(w.start_time)} → {fmtDate(w.end_time)}</Text>
                  <TouchableOpacity onPress={() => {
                    Alert.alert('Eliminar', '¿Eliminar esta ventana?', [
                      { text: 'No' },
                      { text: 'Si', style: 'destructive', onPress: async () => { await apiRequest(`/api/maintenance/${w.id}`, { method: 'DELETE' }, token); loadMaintenanceWindows(); }}
                    ]);
                  }} style={{marginTop: 8}}>
                    <Text style={{color: '#ff5252', fontSize: 12}}>Eliminar</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <Text style={{color: '#00d4ff', fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 8}}>📅 Proximas</Text>
              {upcoming.map((w: any) => (
                <View key={w.id} style={{backgroundColor: '#0a1a2e', borderLeftWidth: 3, borderLeftColor: '#00d4ff', borderRadius: 12, padding: 14, marginBottom: 8}}>
                  <Text style={{color: '#eee', fontSize: 15, fontWeight: '700'}}>{w.title}</Text>
                  <Text style={{color: '#888', fontSize: 12, marginTop: 4}}>{w.machine_name || 'Todas'} · {fmtDate(w.start_time)} → {fmtDate(w.end_time)}</Text>
                  <TouchableOpacity onPress={() => {
                    Alert.alert('Eliminar', '¿Eliminar esta ventana?', [
                      { text: 'No' },
                      { text: 'Si', style: 'destructive', onPress: async () => { await apiRequest(`/api/maintenance/${w.id}`, { method: 'DELETE' }, token); loadMaintenanceWindows(); }}
                    ]);
                  }} style={{marginTop: 8}}>
                    <Text style={{color: '#ff5252', fontSize: 12}}>Eliminar</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
          {past.length > 0 && (
            <>
              <Text style={{color: '#607d8b', fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 8}}>📋 Pasadas</Text>
              {past.map((w: any) => (
                <View key={w.id} style={{backgroundColor: '#111d2e', borderRadius: 12, padding: 14, marginBottom: 8}}>
                  <Text style={{color: '#888', fontSize: 14, fontWeight: '600'}}>{w.title}</Text>
                  <Text style={{color: '#555', fontSize: 12, marginTop: 4}}>{w.machine_name || 'Todas'} · {fmtDate(w.start_time)} → {fmtDate(w.end_time)}</Text>
                </View>
              ))}
            </>
          )}
          {maintenanceWindows.length === 0 && (
            <View style={{alignItems: 'center', paddingVertical: 60}}>
              <Text style={{fontSize: 48, marginBottom: 12}}>🔧</Text>
              <Text style={{color: '#607d8b', fontSize: 16}}>Sin ventanas programadas</Text>
            </View>
          )}
        </ScrollView>
        <TouchableOpacity style={{position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8}}
          onPress={() => {
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            setMwStartDate(`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`);
            setMwStartTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
            const end = new Date(now.getTime() + 3600000);
            setMwEndDate(`${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`);
            setMwEndTime(`${pad(end.getHours())}:${pad(end.getMinutes())}`);
            setMwTitle('Mantenimiento'); setMwMachineId('');
            setShowAddMaintenance(true);
          }}>
          <Text style={{fontSize: 28, color: '#0a1628', fontWeight: '700'}}>+</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // AUDIT LOG
  const loadAuditLog = async () => {
    const res = await apiRequest('/api/audit?limit=100', {}, token);
    if (res.ok) setAuditLog(res.data);
  };

  if (showAuditLog) {
    const actionLabels: {[k:string]:string} = {
      login:'🔑 Inicio de sesion', register:'📝 Registro', edit_machine:'✏️ Editar maquina',
      delete_machine:'🗑️ Eliminar maquina', remote_command:'💻 Comando remoto',
      create_maintenance:'🔧 Crear mantenimiento', create_url_monitor:'🌐 Agregar URL',
      wake_on_lan:'⚡ Wake-on-LAN'
    };
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Auditoria" subtitle={`${auditLog.length} acciones`} />
        <TouchableOpacity style={{backgroundColor: '#1a2a3a', borderRadius: 8, padding: 10, marginHorizontal: 16, marginBottom: 8, alignItems: 'center'}} onPress={loadAuditLog}>
          <Text style={{color: '#00d4ff', fontSize: 13, fontWeight: '600'}}>🔄 Actualizar</Text>
        </TouchableOpacity>
        <ScrollView contentContainerStyle={{padding: 16, paddingBottom: 30}}>
          {auditLog.length === 0 ? (
            <View style={{alignItems: 'center', paddingVertical: 60}}>
              <Text style={{fontSize: 48, marginBottom: 12}}>📋</Text>
              <Text style={{color: '#607d8b', fontSize: 16}}>Sin acciones registradas</Text>
            </View>
          ) : auditLog.map((a: any, i: number) => {
            const date = new Date(a.created_at);
            return (
              <View key={i} style={{backgroundColor: '#111d2e', borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center'}}>
                <Text style={{fontSize: 20, marginRight: 12}}>{(actionLabels[a.action] || a.action).split(' ')[0]}</Text>
                <View style={{flex: 1}}>
                  <Text style={{color: '#eee', fontSize: 13, fontWeight: '600'}}>{actionLabels[a.action] || a.action}</Text>
                  {a.details && <Text style={{color: '#607d8b', fontSize: 11, marginTop: 2}}>{a.details}</Text>}
                </View>
                <View style={{alignItems: 'flex-end'}}>
                  <Text style={{color: '#555', fontSize: 11}}>{date.toLocaleDateString('es', {day: '2-digit', month: 'short'})}</Text>
                  <Text style={{color: '#3a5068', fontSize: 11}}>{date.toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'})}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  // CONFIG EMAIL / SMTP
  if (showSmtp) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Configurar Email" subtitle="Notificaciones por email" />
        <ScrollView contentContainerStyle={{padding: 24}}>

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

          <View style={{height: 30}} />
        </ScrollView>
      </View>
    );
  }

  // CAMBIAR CONTRASEÑA
  if (showChangePass) {
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Cambiar contraseña" />
        <View style={{padding: 24}}>
          <TextInput style={s.input} placeholder="Contraseña actual" placeholderTextColor="#555" value={currentPass} onChangeText={setCurrentPass} secureTextEntry />
          <TextInput style={s.input} placeholder="Nueva contraseña (min 6 caracteres)" placeholderTextColor="#555" value={newPass} onChangeText={setNewPass} secureTextEntry />
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
        </View>
      </View>
    );
  }

  // UPTIME
  if (uptimeMachine) {
    const avgUptime = uptimeData.length > 0
      ? Math.round(uptimeData.reduce((a: number, d: any) => a + d.percentage, 0) / uptimeData.length)
      : 0;

    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Uptime" subtitle={uptimeMachine.machine_name} />
        <View style={{paddingHorizontal: 16, paddingTop: 8}}>
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
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Historial de IPs" subtitle={ipHistoryMachine.machine_name} />
        <Text style={{color: '#aaa', fontSize: 12, paddingHorizontal: 16, marginBottom: 8}}>IP actual: <Text style={{color: '#00e676', fontWeight: '700'}}>{ipHistoryMachine.public_ip || '---'}</Text></Text>

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
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Metricas" subtitle={metricsMachine.machine_name} />
        <View style={{flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8}}>
          {[6, 24, 48, 72, 168].map(h => (
            <TouchableOpacity key={h} onPress={() => { setMetricsHours(h); loadMetrics(metricsMachine.id, h); }}
              style={{backgroundColor: metricsHours === h ? '#00d4ff' : '#1a2a3a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8}}>
              <Text style={{color: metricsHours === h ? '#0a1628' : '#607d8b', fontWeight: '600', fontSize: 13}}>{h < 24 ? `${h}h` : `${h/24}d`}</Text>
            </TouchableOpacity>
          ))}
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
        <Text style={s.sub}>Server Monitoring</Text>
        <TextInput style={s.input} placeholder={t('login_email') || 'Email'} placeholderTextColor="#555" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder={t('current_pass') || 'Password'} placeholderTextColor="#555" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} />
        <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{flexDirection: 'row', alignItems: 'center', marginBottom: 12}}>
          <View style={{width: 20, height: 20, borderWidth: 2, borderColor: showPassword ? '#00d4ff' : '#555', borderRadius: 4, marginRight: 8, backgroundColor: showPassword ? '#00d4ff' : 'transparent', alignItems: 'center', justifyContent: 'center'}}>
            {showPassword && <Text style={{color: '#0a1628', fontSize: 14, fontWeight: '700'}}>✓</Text>}
          </View>
          <Text style={{color: '#607d8b', fontSize: 13}}>{t('show_password')}</Text>
        </TouchableOpacity>
        {error ? <Text style={s.err}>{error}</Text> : null}
        <TouchableOpacity style={s.btn} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#0a1628" /> : <Text style={s.btnTxt}>{isSignUp ? t('create_account') : t('login_btn')}</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setIsSignUp(!isSignUp); setError(''); }}>
          <Text style={s.link}>{isSignUp ? t('have_account') : t('new_account')}</Text>
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
    const openEdit = () => { setEditingMachine(item); setEditName(item.machine_name); setEditGrupo(item.grupo || ''); setEditDnsUrl(item.dns_update_url || ''); setEditDnsHost(item.dns_host || ''); setEditCheckIp(item.check_ip_change !== false); setEditNotes(item.notes || ''); setEditAlertCpu(item.alert_cpu ? String(item.alert_cpu) : ''); setEditAlertRam(item.alert_ram ? String(item.alert_ram) : ''); setEditAlertDisk(item.alert_disk ? String(item.alert_disk) : ''); setEditAlertPing(item.alert_ping ? String(item.alert_ping) : ''); setEditAlertOffline(item.alert_offline !== false); setEditMac(item.mac_address || ''); setEditWolBroadcast(item.wol_broadcast || '255.255.255.255'); setEditGeoCity(item.geo_city || ''); setEditGeoRegion(item.geo_region || ''); setEditGeoCountry(item.geo_country || ''); setEditGeoLat(item.geo_lat ? String(item.geo_lat) : ''); setEditGeoLon(item.geo_lon ? String(item.geo_lon) : ''); setGeoSearchAddr(''); setGeoSearchResult(''); };

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
            {icon: '⏱', label: t('uptime'), action: () => openUptime(item)},
            {icon: '📈', label: t('metrics'), action: () => openMetrics(item)},
            {icon: '🌐', label: t('ips'), action: () => openIpHistory(item)},
            {icon: '💿', label: t('disks'), action: () => { setDetailMachine(item); setDetailMonitored(item.monitored_disks || []); const ad: {[k:string]:string} = {}; if (item.alert_disks) { Object.entries(item.alert_disks).forEach(([k,v]) => { ad[k] = String(v); }); } setDetailAlertDisks(ad); }},
            {icon: '📋', label: t('logs'), action: async () => { const res = await apiRequest(`/api/machines/${item.id}/logs`, {}, token); if (res.ok) Alert.alert('Logs: ' + item.machine_name, res.data.logs || t('no_data')); }},
            {icon: '⚙', label: t('services'), action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/services`, {}, token);
              if (res.ok) {
                const svcs = (res.data.services || []).map((s: any) => `${s.state === 'RUNNING' ? '🟢' : '🔴'} ${s.display} (${s.state})`).join('\n');
                const ports = (res.data.open_ports || []).join(', ');
                Alert.alert(item.machine_name, (svcs || 'Sin servicios') + '\n\nPuertos: ' + (ports || 'Sin datos'));
              }
            }},
            {icon: '💾', label: t('config'), action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/config`, {}, token);
              if (res.ok) Alert.alert('Config: ' + item.machine_name, res.data.config ? JSON.stringify(res.data.config, null, 2) + '\n\nBackup: ' + (res.data.backed_up_at ? new Date(res.data.backed_up_at).toLocaleString() : '---') : 'Sin backup');
            }},
            ...(!item.is_online && item.mac_address ? [{icon: '⚡', label: 'WOL', action: async () => {
              const res = await apiRequest(`/api/machines/${item.id}/wol`, { method: 'POST' }, token);
              if (res.ok) Alert.alert('WOL', res.data.message || 'Magic packet enviado');
              else Alert.alert('Error', res.data?.error || 'Error al enviar WOL');
            }}] : []),
            {icon: '🛡', label: t('backup'), action: async () => {
              setBackupMachine(item); setBackupData(null);
              const res = await apiRequest(`/api/machines/${item.id}/backup`, {}, token);
              if (res.ok) setBackupData(res.data);
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

  // BACKUP SCREEN
  if (backupMachine) {
    const d = backupData;
    const icons: {[k:string]:string} = { ok: '🛡', error: '🚨', warning: '⚠', never: '📋', not_configured: '❌', unknown: '❓' };
    const colors: {[k:string]:string} = { ok: '#00e676', error: '#ff5252', warning: '#ff9800', never: '#ff9800', not_configured: '#607d8b', unknown: '#607d8b' };
    const st = d?.status || 'unknown';
    return (
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Backup" subtitle={backupMachine.machine_name} />
        <ScrollView contentContainerStyle={{padding: 24}}>
          <View style={{alignItems: 'center', paddingVertical: 30}}>
            <Text style={{fontSize: 60, marginBottom: 12}}>{!d ? '⏳' : icons[st] || '❓'}</Text>
            <Text style={{fontSize: 20, fontWeight: '800', color: colors[st] || '#607d8b'}}>{!d ? 'Cargando...' : d.status_text || st}</Text>
          </View>
          {d && (
            <View style={{backgroundColor: '#0d1b2a', borderRadius: 14, padding: 18}}>
              {d.last_backup && (
                <View style={{marginBottom: 14}}>
                  <Text style={{color: '#607d8b', fontSize: 12, marginBottom: 4}}>Ultima fecha del backup:</Text>
                  <Text style={{color: '#eee', fontSize: 18, fontWeight: '700'}}>{d.last_backup}</Text>
                </View>
              )}
              {d.message && (
                <View style={{backgroundColor: st === 'error' ? '#1a0a0a' : st === 'warning' ? '#1a1500' : '#111d2e', borderRadius: 10, padding: 12, marginBottom: 14, borderLeftWidth: 3, borderLeftColor: colors[st] || '#607d8b'}}>
                  <Text style={{color: '#ccc', fontSize: 13}}>{d.message}</Text>
                </View>
              )}
              {d.checked_at && <Text style={{color: '#3a5068', fontSize: 11}}>Chequeado: {d.checked_at}</Text>}
            </View>
          )}
          <TouchableOpacity style={[s.btn, {marginTop: 20, backgroundColor: '#1a2a3a'}]} onPress={async () => {
            const r = await apiRequest(`/api/machines/${backupMachine.id}/check-backup`, { method: 'POST' }, token);
            if (r.ok) Alert.alert('Solicitado', 'El resultado aparece en ~30 segundos');
          }}>
            <Text style={{color: '#00d4ff', fontSize: 14, fontWeight: '700'}}>🔄 Forzar chequeo</Text>
          </TouchableOpacity>
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
      <View style={{flex: 1, backgroundColor: '#0a1628'}}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1b2a" />
        <BackHeader title="Empresa y Equipo" />
        <ScrollView contentContainerStyle={{padding: 24}}>

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

          <View style={{height: 30}} />
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
        <Text style={{color: '#00d4ff', fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 6}}>Ubicacion</Text>
        <Text style={{color: '#555', fontSize: 10, marginBottom: 8}}>Busca por direccion o edita manualmente.</Text>
        <View style={{flexDirection: 'row', marginBottom: 6}}>
          <TextInput style={[s.input, {flex: 1, marginBottom: 0, marginRight: 6}]} value={geoSearchAddr} onChangeText={setGeoSearchAddr} placeholder="Ej: Don Torcuato, Buenos Aires" placeholderTextColor="#555" returnKeyType="search" onSubmitEditing={geocodeAddress} />
          <TouchableOpacity onPress={geocodeAddress} disabled={geoSearching} style={{backgroundColor: '#00d4ff', borderRadius: 10, paddingHorizontal: 14, justifyContent: 'center'}}>
            <Text style={{color: '#fff', fontWeight: '700', fontSize: 13}}>{geoSearching ? '...' : '📍'}</Text>
          </TouchableOpacity>
        </View>
        {geoSearchResult ? <Text style={{color: geoSearchResult.startsWith('No se') || geoSearchResult.startsWith('Error') ? '#F44336' : '#4CAF50', fontSize: 11, marginBottom: 6}} numberOfLines={2}>{geoSearchResult}</Text> : null}
        <View style={{flexDirection: 'row', marginBottom: 8}}>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Ciudad</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editGeoCity} onChangeText={setEditGeoCity} placeholder="Don Torcuato" placeholderTextColor="#555" />
          </View>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Provincia</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editGeoRegion} onChangeText={setEditGeoRegion} placeholder="Buenos Aires" placeholderTextColor="#555" />
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Pais</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editGeoCountry} onChangeText={setEditGeoCountry} placeholder="Argentina" placeholderTextColor="#555" />
          </View>
        </View>
        <View style={{flexDirection: 'row', marginBottom: 12}}>
          <View style={{flex: 1, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Latitud</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editGeoLat} onChangeText={setEditGeoLat} placeholder="-34.4833" placeholderTextColor="#555" keyboardType="numeric" />
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Longitud</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editGeoLon} onChangeText={setEditGeoLon} placeholder="-58.6167" placeholderTextColor="#555" keyboardType="numeric" />
          </View>
        </View>

        <Text style={{color: '#00d4ff', fontSize: 14, fontWeight: '700', marginTop: 8, marginBottom: 10}}>Wake-on-LAN</Text>
        <View style={{flexDirection: 'row', marginBottom: 8}}>
          <View style={{flex: 2, marginRight: 6}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>MAC Address</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editMac} onChangeText={setEditMac} placeholder="AA:BB:CC:DD:EE:FF" placeholderTextColor="#555" autoCapitalize="characters" />
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: '#888', fontSize: 11, marginBottom: 3}}>Broadcast IP</Text>
            <TextInput style={[s.input, {marginBottom: 0}]} value={editWolBroadcast} onChangeText={setEditWolBroadcast} placeholder="255.255.255.255" placeholderTextColor="#555" />
          </View>
        </View>
        <Text style={{color: '#555', fontSize: 10, marginBottom: 12}}>Necesario para encender la maquina remotamente con Wake-on-LAN</Text>

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
      <View style={{backgroundColor: '#0d1b2a', paddingTop: 46, paddingHorizontal: 16, paddingBottom: 12}}>
        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <TouchableOpacity onPress={() => setMenuOpen(!menuOpen)} style={{padding: 8, marginRight: 8}}>
              <Text style={{color: '#607d8b', fontSize: 22}}>{'☰'}</Text>
            </TouchableOpacity>
            <Text style={{fontSize: 24, marginRight: 8}}>{'👁'}</Text>
            <View>
              <Text style={{fontSize: 20, fontWeight: '800'}}><Text style={{color: '#eee'}}>Server</Text><Text style={{color: '#00d4ff'}}>Eyes</Text></Text>
              <Text style={{color: '#607d8b', fontSize: 11}}>{machines.length} {t('machines_count')}</Text>
            </View>
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <TouchableOpacity onPress={() => loadMachines()} style={{padding: 8}}><Text style={{color: '#607d8b', fontSize: 16}}>{'🔄'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { setViewMode(viewMode === 'all' ? 'groups' : 'all'); }} style={{padding: 8}}>
              <Text style={{color: viewMode === 'groups' ? '#00d4ff' : '#607d8b', fontSize: 16}}>{viewMode === 'all' ? '📁' : '📋'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Menu hamburguesa */}
      {menuOpen && (
        <TouchableOpacity activeOpacity={1} onPress={() => setMenuOpen(false)} style={{position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 100}}>
          <View style={{backgroundColor: '#0d1b2a', width: 280, height: '100%', paddingTop: 50, borderRightWidth: 1, borderRightColor: '#1a2a3a'}}>
            <View style={{paddingHorizontal: 20, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: '#1a2a3a'}}>
              <Text style={{fontSize: 20, fontWeight: '800'}}><Text style={{color: '#eee'}}>Server</Text><Text style={{color: '#00d4ff'}}>Eyes</Text></Text>
              <Text style={{color: '#607d8b', fontSize: 12, marginTop: 2}}>{machines.length} {t('machines_count')}</Text>
            </View>
            {[
              {icon: '🖥', label: lang === 'en' ? 'Servers' : 'Servidores', action: () => { setViewMode('all'); setMenuOpen(false); }},
              {icon: '📁', label: lang === 'en' ? 'Groups' : 'Grupos', action: () => { setViewMode('groups'); setMenuOpen(false); }},
              {icon: '🌐', label: 'URLs', action: async () => { setMenuOpen(false); await loadUrlMonitors(); setShowUrlMonitors(true); }},
              {icon: '🔧', label: 'Mantenimiento', action: async () => { setMenuOpen(false); await loadMaintenanceWindows(); setShowMaintenance(true); }},
              {icon: '📜', label: 'Auditoria', action: async () => { setMenuOpen(false); await loadAuditLog(); setShowAuditLog(true); }},
              {icon: '👥', label: t('team'), action: async () => { setMenuOpen(false); const res = await apiRequest('/api/organization', {}, token); if (res.ok) { setOrgData(res.data); if (res.data.organization) { setOrgName(res.data.organization.name); setOrgAddress(res.data.organization.address || ''); setOrgPhone(res.data.organization.phone || ''); } } setShowTeam(true); }},
              {icon: '📋', label: t('logs'), action: () => { setMenuOpen(false); setLogText(_logs.slice(-200).reverse().join('\n')); setShowLogs(true); }},
              {icon: '📧', label: 'Email', action: async () => { setMenuOpen(false); const res = await apiRequest('/api/auth/smtp', {}, token); if (res.ok) { setSmtpHost(res.data.smtp_host || ''); setSmtpPort(String(res.data.smtp_port || 587)); setSmtpUser(res.data.smtp_user || ''); setSmtpPass(''); setSmtpFrom(res.data.smtp_from || ''); setSmtpEnabled(res.data.email_notifications !== false); } setShowSmtp(true); }},
              {icon: '🔒', label: t('change_pass'), action: () => { setMenuOpen(false); setShowChangePass(true); }},
              {icon: '📄', label: 'CSV', action: async () => { setMenuOpen(false); try { const res = await fetch(`${API_URL}/api/machines/export/csv`, { headers: { Authorization: `Bearer ${token}` } }); const csv = await res.text(); const now = new Date(); const fecha = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; const filePath = `${RNFS.CachesDirectoryPath}/servereyes-${fecha}.csv`; await RNFS.writeFile(filePath, csv, 'utf8'); await RNShare.open({ url: `file://${filePath}`, type: 'text/csv', filename: `servereyes-${fecha}.csv`, title: 'Export' }); } catch (e: any) { if (e.message !== 'User did not share') log.error(`Export: ${e.message}`); } }},
              {icon: LANGS[lang]?.flag || '🌐', label: `${t('language')}: ${LANGS[lang]?.name}`, action: () => { const langs = Object.keys(LANGS); const idx = langs.indexOf(lang); changeLang(langs[(idx + 1) % langs.length]); }},
            ].map((item, i) => (
              <TouchableOpacity key={i} onPress={item.action} style={{flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#111d2e'}}>
                <Text style={{fontSize: 18, marginRight: 14, width: 28, textAlign: 'center'}}>{item.icon}</Text>
                <Text style={{color: '#ccc', fontSize: 15}}>{item.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => { setMenuOpen(false); log.info('Logout'); setAndSaveToken(null); }} style={{flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginTop: 'auto', borderTopWidth: 1, borderTopColor: '#1a2a3a'}}>
              <Text style={{fontSize: 18, marginRight: 14, width: 28, textAlign: 'center'}}>{'🚪'}</Text>
              <Text style={{color: '#ff5252', fontSize: 15, fontWeight: '600'}}>{t('logout')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      )}

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
