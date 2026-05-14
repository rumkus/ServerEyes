import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, StatusBar, TextInput, Modal, ActivityIndicator } from 'react-native';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { getMachines, addMachine, deleteMachine, clerkLogin } from '../services/api';

export default function HomeScreen() {
  const { signOut, userId } = useAuth();
  const { user } = useUser();
  const [token, setToken] = useState<string | null>(null);
  const [machines, setMachines] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(true);

  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Al entrar, login en nuestro backend con datos de Clerk
  useEffect(() => {
    if (userId && user?.primaryEmailAddress?.emailAddress) {
      clerkLogin(userId, user.primaryEmailAddress.emailAddress).then(res => {
        if (res.ok) {
          setToken(res.data.token);
        }
        setLoading(false);
      }).catch(() => setLoading(false));
    }
  }, [userId, user]);

  const loadMachines = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const res = await getMachines(tokenRef.current);
      if (res.ok) setMachines(res.data);
    } catch {}
  }, []);

  useEffect(() => {
    if (!token) return;
    loadMachines();
    const interval = setInterval(loadMachines, 10000);
    return () => clearInterval(interval);
  }, [token, loadMachines]);

  const handleAdd = async () => {
    if (!newName.trim() || !token) return;
    try {
      const res = await addMachine(token, newName.trim());
      if (res.ok) { setNewKey(res.data.machine_key); setNewName(''); loadMachines(); }
    } catch { Alert.alert('Error', 'No se pudo registrar'); }
  };

  const handleDelete = (m: any) => {
    Alert.alert('Eliminar', `¿Eliminar "${m.machine_name}"?`, [
      { text: 'No' },
      { text: 'Si', style: 'destructive', onPress: async () => {
        if (token) { await deleteMachine(token, m.id); loadMachines(); }
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

  if (loading) {
    return (
      <View style={{flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', alignItems: 'center'}}>
        <ActivityIndicator size="large" color="#00d4ff" />
      </View>
    );
  }

  return (
    <View style={{flex: 1, backgroundColor: '#1a1a2e'}}>
      <StatusBar barStyle="light-content" backgroundColor="#16213e" />
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>👁 ServerEyes</Text>
          <Text style={{color: '#888', fontSize: 13}}>{machines.length} maquinas</Text>
        </View>
        <TouchableOpacity style={s.logoutBtn} onPress={() => signOut()}>
          <Text style={{color: '#ff5252', fontWeight: '600'}}>Salir</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={machines}
        keyExtractor={i => i.id.toString()}
        contentContainerStyle={{padding: 16, paddingBottom: 80}}
        onRefresh={loadMachines}
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
            onLongPress={() => handleDelete(item)}>
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

      <Modal visible={showAdd} transparent animationType="slide">
        <View style={{flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24}}>
          <View style={{backgroundColor: '#16213e', borderRadius: 20, padding: 24}}>
            {newKey ? (
              <>
                <Text style={{fontSize: 20, fontWeight: '700', color: '#eee', textAlign: 'center', marginBottom: 16}}>Maquina registrada</Text>
                <Text style={{color: '#888', fontSize: 13, marginBottom: 8}}>Clave para el cliente Windows:</Text>
                <Text style={{backgroundColor: '#1a1a2e', borderRadius: 8, padding: 12, fontSize: 14, color: '#00d4ff', fontFamily: 'monospace', textAlign: 'center', marginBottom: 16}}>{newKey}</Text>
                <Text style={{color: '#888', fontSize: 12, textAlign: 'center', marginBottom: 16}}>Copia esta clave y pegala en ServerEyes del Windows</Text>
                <TouchableOpacity style={s.modalBtn} onPress={() => { setShowAdd(false); setNewKey(''); }}>
                  <Text style={s.modalBtnTxt}>Cerrar</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={{fontSize: 20, fontWeight: '700', color: '#eee', textAlign: 'center', marginBottom: 16}}>Agregar maquina</Text>
                <TextInput
                  style={{backgroundColor: '#1a1a2e', borderWidth: 2, borderColor: '#2a2a4a', borderRadius: 12, padding: 14, fontSize: 16, color: '#eee', marginBottom: 16}}
                  placeholder="Nombre de la maquina"
                  placeholderTextColor="#666"
                  value={newName}
                  onChangeText={setNewName}
                />
                <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
                  <TouchableOpacity style={[s.modalBtn, {backgroundColor: '#2a2a4a', marginRight: 8}]} onPress={() => { setShowAdd(false); setNewName(''); }}>
                    <Text style={{color: '#888', fontWeight: '700', fontSize: 15}}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.modalBtn, {marginLeft: 8}]} onPress={handleAdd}>
                    <Text style={s.modalBtnTxt}>Registrar</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, backgroundColor: '#16213e' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#00d4ff' },
  logoutBtn: { backgroundColor: '#2a2a4a', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  card: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center', justifyContent: 'center', elevation: 8 },
  fabTxt: { fontSize: 30, color: '#1a1a2e', fontWeight: '700', marginTop: -2 },
  modalBtn: { flex: 1, backgroundColor: '#00d4ff', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalBtnTxt: { fontSize: 15, fontWeight: '700', color: '#1a1a2e' },
});
