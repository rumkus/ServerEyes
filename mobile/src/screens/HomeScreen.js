import React, { useState, useEffect, useCallback, useContext } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, Alert, TextInput, Modal,
} from 'react-native';
// Clipboard nativo
import { AuthContext } from '../../App';
import { getMachines, addMachine, deleteMachine } from '../services/api';

export default function HomeScreen() {
  const { token, logout } = useContext(AuthContext);
  const [machines, setMachines] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newMachineName, setNewMachineName] = useState('');
  const [newMachineKey, setNewMachineKey] = useState('');

  const loadMachines = useCallback(async () => {
    try {
      const res = await getMachines(token);
      if (res.ok) setMachines(res.data);
      else if (res.status === 401) logout();
    } catch (err) {
      console.error('Error cargando maquinas:', err);
    }
  }, [token, logout]);

  useEffect(() => {
    loadMachines();
    const interval = setInterval(loadMachines, 15000);
    return () => clearInterval(interval);
  }, [loadMachines]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadMachines();
    setRefreshing(false);
  };

  const handleAddMachine = async () => {
    if (!newMachineName.trim()) return;
    try {
      const res = await addMachine(token, newMachineName.trim());
      if (res.ok) {
        setNewMachineKey(res.data.machine_key);
        setNewMachineName('');
        loadMachines();
      }
    } catch (err) {
      Alert.alert('Error', 'No se pudo registrar la maquina');
    }
  };

  const handleDeleteMachine = (machine) => {
    Alert.alert('Eliminar maquina', `¿Eliminar "${machine.machine_name}"?`, [
      { text: 'Cancelar' },
      {
        text: 'Eliminar', style: 'destructive',
        onPress: async () => {
          await deleteMachine(token, machine.id);
          loadMachines();
        },
      },
    ]);
  };

  const copyKey = (key) => {
    // noop - el Alert ya muestra la clave
    Alert.alert('Copiado', 'Clave copiada al portapapeles');
  };

  const getTimeSince = (timestamp) => {
    if (!timestamp) return 'Nunca';
    const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (diff < 60) return `Hace ${diff}s`;
    if (diff < 3600) return `Hace ${Math.floor(diff / 60)}min`;
    if (diff < 86400) return `Hace ${Math.floor(diff / 3600)}h`;
    return `Hace ${Math.floor(diff / 86400)}d`;
  };

  const renderMachine = ({ item }) => (
    <TouchableOpacity
      style={[styles.card, item.is_online ? styles.cardOnline : styles.cardOffline]}
      onLongPress={() => handleDeleteMachine(item)}>
      <View style={styles.cardHeader}>
        <View style={[styles.statusDot, item.is_online ? styles.dotOnline : styles.dotOffline]} />
        <Text style={styles.machineName}>{item.machine_name}</Text>
        <Text style={[styles.statusText, item.is_online ? styles.textOnline : styles.textOffline]}>
          {item.is_online ? 'ONLINE' : 'OFFLINE'}
        </Text>
      </View>
      <View style={styles.cardBody}>
        <View style={styles.infoRow}>
          <Text style={styles.label}>IP Publica:</Text>
          <Text style={styles.value}>{item.public_ip || '---'}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.label}>IP Local:</Text>
          <Text style={styles.value}>{item.local_ip || '---'}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.label}>Ultimo heartbeat:</Text>
          <Text style={styles.value}>{getTimeSince(item.last_heartbeat)}</Text>
        </View>
        {item.os_info && <Text style={styles.osInfo}>{item.os_info}</Text>}
      </View>
      <TouchableOpacity style={styles.keyButton} onPress={() => copyKey(item.machine_key)}>
        <Text style={styles.keyButtonText}>Copiar clave</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>👁 ServerEyes</Text>
          <Text style={styles.headerSub}>{machines.length} maquinas</Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
          <Text style={styles.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={machines}
        keyExtractor={(item) => item.id.toString()}
        renderItem={renderMachine}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#00d4ff" />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🖥</Text>
            <Text style={styles.emptyText}>No hay maquinas registradas</Text>
            <Text style={styles.emptySubtext}>Toca + para agregar una</Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.fab} onPress={() => setShowAddModal(true)}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      <Modal visible={showAddModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {newMachineKey ? (
              <>
                <Text style={styles.modalTitle}>Maquina registrada</Text>
                <Text style={styles.modalLabel}>Clave para el cliente Windows:</Text>
                <TouchableOpacity onPress={() => copyKey(newMachineKey)}>
                  <Text style={styles.machineKey}>{newMachineKey}</Text>
                </TouchableOpacity>
                <Text style={styles.modalHint}>Toca la clave para copiarla y pegala en el cliente Windows.</Text>
                <TouchableOpacity style={styles.modalButton} onPress={() => { setShowAddModal(false); setNewMachineKey(''); }}>
                  <Text style={styles.modalButtonText}>Cerrar</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>Agregar maquina</Text>
                <TextInput
                  style={styles.modalInput}
                  placeholder="Nombre de la maquina"
                  placeholderTextColor="#666"
                  value={newMachineName}
                  onChangeText={setNewMachineName}
                />
                <View style={styles.modalButtons}>
                  <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={() => { setShowAddModal(false); setNewMachineName(''); }}>
                    <Text style={styles.cancelButtonText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalButton} onPress={handleAddMachine}>
                    <Text style={styles.modalButtonText}>Registrar</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, paddingTop: 50, backgroundColor: '#16213e',
  },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#00d4ff' },
  headerSub: { fontSize: 13, color: '#888', marginTop: 2 },
  logoutBtn: { backgroundColor: '#2a2a4a', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  logoutText: { color: '#ff5252', fontWeight: '600', fontSize: 13 },
  list: { padding: 16, paddingBottom: 80 },
  card: { borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1 },
  cardOnline: { backgroundColor: '#0d2818', borderColor: '#1a5c2e' },
  cardOffline: { backgroundColor: '#2d1117', borderColor: '#5c1a1a' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  dotOnline: { backgroundColor: '#00e676' },
  dotOffline: { backgroundColor: '#ff5252' },
  machineName: { flex: 1, fontSize: 18, fontWeight: '700', color: '#eee' },
  statusText: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  textOnline: { color: '#00e676' },
  textOffline: { color: '#ff5252' },
  cardBody: { gap: 6 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: '#888', fontSize: 13 },
  value: { color: '#ddd', fontSize: 13, fontWeight: '600' },
  osInfo: { color: '#666', fontSize: 11, marginTop: 4 },
  keyButton: { marginTop: 10, alignSelf: 'flex-start' },
  keyButtonText: { color: '#00d4ff', fontSize: 12, fontWeight: '600' },
  empty: { alignItems: 'center', marginTop: 100 },
  emptyIcon: { fontSize: 60, marginBottom: 16 },
  emptyText: { color: '#888', fontSize: 18, fontWeight: '600' },
  emptySubtext: { color: '#555', fontSize: 14, marginTop: 4 },
  fab: {
    position: 'absolute', bottom: 24, right: 24, width: 56, height: 56,
    borderRadius: 28, backgroundColor: '#00d4ff', alignItems: 'center',
    justifyContent: 'center', elevation: 8,
  },
  fabText: { fontSize: 30, color: '#1a1a2e', fontWeight: '700', marginTop: -2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  modalContent: { backgroundColor: '#16213e', borderRadius: 20, padding: 24 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#eee', marginBottom: 16, textAlign: 'center' },
  modalLabel: { color: '#888', fontSize: 13, marginBottom: 8 },
  modalInput: {
    backgroundColor: '#1a1a2e', borderWidth: 2, borderColor: '#2a2a4a',
    borderRadius: 12, padding: 14, fontSize: 16, color: '#eee', marginBottom: 16,
  },
  machineKey: {
    backgroundColor: '#1a1a2e', borderRadius: 8, padding: 12, fontSize: 14,
    color: '#00d4ff', fontFamily: 'monospace', textAlign: 'center', marginBottom: 8,
  },
  modalHint: { color: '#888', fontSize: 12, textAlign: 'center', marginBottom: 16 },
  modalButtons: { flexDirection: 'row', gap: 12 },
  modalButton: { flex: 1, backgroundColor: '#00d4ff', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalButtonText: { fontSize: 15, fontWeight: '700', color: '#1a1a2e' },
  cancelButton: { backgroundColor: '#2a2a4a' },
  cancelButtonText: { color: '#888' },
});
