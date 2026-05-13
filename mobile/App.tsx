import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';

const API_URL = 'https://servereyes-production.up.railway.app';
const CLERK_DOMAIN = 'solid-yak-82.clerk.accounts.dev';
const CLERK_PK = 'pk_test_c29saWQteWFrLTgyLmNsZXJrLmFjY291bnRzLmRldiQ';

async function apiRequest(path: string, options: any = {}, token: string | null = null) {
  const headers: any = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await response.json();
  return { ok: response.ok, data };
}

// Script para inyectar despues del login en Clerk
const CLERK_CHECK_SESSION = `
(function() {
  try {
    if (window.Clerk && window.Clerk.user && window.Clerk.session) {
      window.Clerk.session.getToken().then(function(token) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'clerk_token',
          token: token,
          email: window.Clerk.user.primaryEmailAddress ? window.Clerk.user.primaryEmailAddress.emailAddress : '',
          userId: window.Clerk.user.id
        }));
      });
    }
  } catch(e) {}
})();
true;
`;

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [clerkToken, setClerkToken] = useState<string | null>(null);
  const [machines, setMachines] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const webviewRef = useRef<any>(null);

  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Cuando recibimos token de Clerk, registrar/login en nuestro backend
  const handleClerkAuth = async (clerkData: any) => {
    setLoginLoading(true);
    try {
      // Intentar login con el token de Clerk
      const res = await apiRequest('/api/auth/clerk-login', {
        method: 'POST',
        body: JSON.stringify({
          clerk_id: clerkData.userId,
          email: clerkData.email,
          clerk_token: clerkData.token
        })
      });

      if (res.ok) {
        setToken(res.data.token);
      } else {
        Alert.alert('Error', res.data.error || 'Error de autenticacion');
      }
    } catch (err) {
      Alert.alert('Error', 'Error de conexion');
    }
    setLoginLoading(false);
  };

  const loadMachines = async (t?: string) => {
    try {
      const res = await apiRequest('/api/machines', {}, t || tokenRef.current);
      if (res.ok) setMachines(res.data);
    } catch {}
  };

  // Auto-refresh cada 10 segundos
  useEffect(() => {
    if (!token) return;
    loadMachines();
    const interval = setInterval(() => loadMachines(), 10000);
    return () => clearInterval(interval);
  }, [token]);

  const addMachine = async () => {
    if (!newName.trim()) return;
    try {
      const res = await apiRequest('/api/machines', { method: 'POST', body: JSON.stringify({ machine_name: newName.trim() }) }, token);
      if (res.ok) { setNewKey(res.data.machine_key); setNewName(''); loadMachines(); }
    } catch { Alert.alert('Error', 'No se pudo registrar'); }
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

  // LOGIN con Clerk WebView
  if (!token) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        {loginLoading ? (
          <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
            <ActivityIndicator size="large" color="#00d4ff" />
            <Text style={{color: '#888', marginTop: 16}}>Iniciando sesion...</Text>
          </View>
        ) : (
          <WebView
            source={{ uri: `https://accounts.${CLERK_DOMAIN}/sign-in` }}
            style={{flex: 1, backgroundColor: '#1a1a2e'}}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            thirdPartyCookiesEnabled={true}
            injectedJavaScript={CLERK_CHECK_SESSION}
            onNavigationStateChange={(navState) => {
              // Despues de sign-in, Clerk redirige - chequeamos session
              if (navState.url && !navState.url.includes('/sign-in') && !navState.url.includes('/sign-up')) {
                webviewRef.current?.injectJavaScript(CLERK_CHECK_SESSION);
                // Retry despues de un momento
                setTimeout(() => webviewRef.current?.injectJavaScript(CLERK_CHECK_SESSION), 2000);
                setTimeout(() => webviewRef.current?.injectJavaScript(CLERK_CHECK_SESSION), 4000);
              }
            }}
            onMessage={(event) => {
              try {
                const data = JSON.parse(event.nativeEvent.data);
                if (data.type === 'clerk_token') {
                  handleClerkAuth(data);
                }
              } catch {}
            }}
            ref={webviewRef}
          />
        )}
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
            <View style={s.inputContainer}>
              <WebView
                source={{ html: `<html><body style="margin:0;background:#16213e"><input type="text" id="inp" placeholder="Nombre de la maquina" style="width:100%;padding:14px;background:#16213e;border:2px solid #2a2a4a;border-radius:12px;color:#eee;font-size:16px;outline:none;box-sizing:border-box;" oninput="window.ReactNativeWebView.postMessage(this.value)"/></body></html>` }}
                style={{height: 54, backgroundColor: '#16213e'}}
                onMessage={(e) => setNewName(e.nativeEvent.data)}
              />
            </View>
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

  // HOME
  return (
    <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
      <StatusBar barStyle="light-content" backgroundColor="#16213e" />
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>👁 ServerEyes</Text>
          <Text style={{color: '#888', fontSize: 13}}>{machines.length} maquinas</Text>
        </View>
        <TouchableOpacity style={s.logoutBtn} onPress={() => setToken(null)}>
          <Text style={{color: '#ff5252', fontWeight: '600'}}>Salir</Text>
        </TouchableOpacity>
      </View>

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
        renderItem={({item}) => (
          <TouchableOpacity
            style={[s.card, item.is_online ? {backgroundColor: '#0d2818', borderColor: '#1a5c2e'} : {backgroundColor: '#2d1117', borderColor: '#5c1a1a'}]}
            onLongPress={() => deleteMachine(item)}>
            <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 10}}>
              <View style={{width: 10, height: 10, borderRadius: 5, marginRight: 8, backgroundColor: item.is_online ? '#00e676' : '#ff5252'}} />
              <Text style={{flex: 1, fontSize: 18, fontWeight: '700', color: '#eee'}}>{item.machine_name}</Text>
              <Text style={{fontSize: 12, fontWeight: '700', color: item.is_online ? '#00e676' : '#ff5252'}}>
                {item.is_online ? 'ONLINE' : 'OFFLINE'}
              </Text>
            </View>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
              <Text style={{color: '#888', fontSize: 13}}>IP Publica:</Text>
              <Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{item.public_ip || '---'}</Text>
            </View>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4}}>
              <Text style={{color: '#888', fontSize: 13}}>IP Local:</Text>
              <Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{item.local_ip || '---'}</Text>
            </View>
            <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
              <Text style={{color: '#888', fontSize: 13}}>Heartbeat:</Text>
              <Text style={{color: '#ddd', fontSize: 13, fontWeight: '600'}}>{timeSince(item.last_heartbeat)}</Text>
            </View>
            {item.os_info && <Text style={{color: '#555', fontSize: 11, marginTop: 6}}>{item.os_info}</Text>}
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity style={s.fab} onPress={() => setShowAdd(true)}>
        <Text style={s.fabTxt}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', padding: 24 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#00d4ff', textAlign: 'center' },
  sub: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 4, marginBottom: 20 },
  btn: { backgroundColor: '#00d4ff', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnTxt: { fontSize: 16, fontWeight: '700', color: '#1a1a2e' },
  link: { color: '#00d4ff', textAlign: 'center', marginTop: 16, fontSize: 14 },
  key: { backgroundColor: '#16213e', borderRadius: 8, padding: 14, fontSize: 15, color: '#00d4ff', textAlign: 'center', marginVertical: 16, fontFamily: 'monospace' },
  inputContainer: { height: 54, marginBottom: 12, borderRadius: 12, overflow: 'hidden' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, backgroundColor: '#16213e' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#00d4ff' },
  logoutBtn: { backgroundColor: '#2a2a4a', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  card: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabTxt: { fontSize: 30, color: '#1a1a2e', fontWeight: '700', marginTop: -2 },
});
