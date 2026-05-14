import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, Alert, StatusBar, Vibration } from 'react-native';

const API_URL = 'https://servereyes-production.up.railway.app';

async function apiRequest(path: string, options: any = {}, token: string | null = null) {
  const headers: any = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await response.json();
  return { ok: response.ok, data };
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [machines, setMachines] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [showPairing, setShowPairing] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingStatus, setPairingStatus] = useState('');
  const [ipAlert, setIpAlert] = useState<{name: string, oldIp: string, newIp: string} | null>(null);

  const handleAuth = async () => {
    if (!email.trim() || !password.trim()) { setError('Completa todos los campos'); return; }
    setLoading(true); setError('');
    try {
      const path = isSignUp ? '/api/auth/register' : '/api/auth/login';
      const res = await apiRequest(path, { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      if (res.ok) { setToken(res.data.token); loadMachines(res.data.token); }
      else setError(res.data.error || 'Error');
    } catch { setError('Error de conexion'); }
    setLoading(false);
  };

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const loadMachines = async (t?: string) => {
    try {
      const res = await apiRequest('/api/machines', {}, t || tokenRef.current);
      if (res.ok) setMachines(res.data);
    } catch {}
  };

  // Chequear cambios de IP
  const checkIPChanges = async () => {
    if (!tokenRef.current) return;
    try {
      const res = await apiRequest('/api/ip-changes', {}, tokenRef.current);
      if (res.ok && res.data.length > 0) {
        const change = res.data[0];
        setIpAlert({ name: change.machine_name, oldIp: change.previous_public_ip, newIp: change.public_ip });
        Vibration.vibrate([0, 300, 200, 300]); // Patron de vibracion
        // Ocultar despues de 15 segundos
        setTimeout(() => setIpAlert(null), 15000);
      }
    } catch {}
  };

  // Auto-refresh cada 10 segundos
  useEffect(() => {
    if (!token) return;
    loadMachines();
    checkIPChanges();
    const interval = setInterval(() => { loadMachines(); checkIPChanges(); }, 10000);
    return () => clearInterval(interval);
  }, [token]);

  const addMachine = async () => {
    if (!newName.trim()) return;
    try {
      const res = await apiRequest('/api/machines', { method: 'POST', body: JSON.stringify({ machine_name: newName.trim() }) }, token);
      if (res.ok) { setNewKey(res.data.machine_key); setNewName(''); loadMachines(); }
    } catch { Alert.alert('Error', 'No se pudo registrar'); }
  };

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

  // LOGIN
  if (!token) {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
        <Text style={s.icon}>👁</Text>
        <Text style={s.title}>ServerEyes</Text>
        <Text style={s.sub}>Monitoreo de maquinas</Text>
        <TextInput style={s.input} placeholder="Email" placeholderTextColor="#666" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="Contraseña" placeholderTextColor="#666" value={password} onChangeText={setPassword} secureTextEntry />
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
