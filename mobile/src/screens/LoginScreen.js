import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { AuthContext } from '../../App';
import { login, register } from '../services/api';

export default function LoginScreen() {
  const { login: setToken } = useContext(AuthContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Completa todos los campos');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = isSignUp
        ? await register(email.trim(), password, '')
        : await login(email.trim(), password);

      if (res.ok) {
        setToken(res.data.token);
      } else {
        setError(res.data.error || 'Error de autenticacion');
      }
    } catch (err) {
      setError('Error de conexion con el servidor');
    }
    setLoading(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.logoContainer}>
        <Text style={styles.icon}>👁</Text>
        <Text style={styles.title}>ServerEyes</Text>
        <Text style={styles.subtitle}>Monitoreo de maquinas</Text>
      </View>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#666"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Contraseña"
          placeholderTextColor="#666"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#1a1a2e" />
          ) : (
            <Text style={styles.buttonText}>
              {isSignUp ? 'Crear cuenta' : 'Iniciar sesion'}
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => { setIsSignUp(!isSignUp); setError(''); }}>
          <Text style={styles.switchText}>
            {isSignUp ? '¿Ya tenes cuenta? Inicia sesion' : '¿No tenes cuenta? Registrate'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', padding: 24 },
  logoContainer: { alignItems: 'center', marginBottom: 40 },
  icon: { fontSize: 60, marginBottom: 10 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#00d4ff' },
  subtitle: { fontSize: 14, color: '#888', marginTop: 4 },
  form: { gap: 14 },
  input: {
    backgroundColor: '#16213e', borderWidth: 2, borderColor: '#2a2a4a',
    borderRadius: 12, padding: 14, fontSize: 16, color: '#eee',
  },
  button: {
    backgroundColor: '#00d4ff', borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 8,
  },
  buttonText: { fontSize: 16, fontWeight: '700', color: '#1a1a2e' },
  error: { color: '#ff5252', textAlign: 'center', fontSize: 13 },
  switchText: { color: '#00d4ff', textAlign: 'center', marginTop: 16, fontSize: 14 },
});
