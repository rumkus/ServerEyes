import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, StatusBar } from 'react-native';
import { useSignIn, useSignUp } from '@clerk/clerk-expo';

export default function LoginScreen() {
  const { signIn, setActive: setSignInActive, isLoaded: isSignInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: isSignUpLoaded } = useSignUp();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = useCallback(async () => {
    if (!isSignInLoaded || !signIn) return;
    setLoading(true); setError('');
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === 'complete' && result.createdSessionId) {
        await setSignInActive({ session: result.createdSessionId });
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || 'Error al iniciar sesion');
    }
    setLoading(false);
  }, [email, password, isSignInLoaded, signIn, setSignInActive]);

  const handleSignUp = useCallback(async () => {
    if (!isSignUpLoaded || !signUp) return;
    setLoading(true); setError('');
    try {
      const result = await signUp.create({ emailAddress: email, password });
      if (result.status === 'complete' && result.createdSessionId) {
        await setSignUpActive({ session: result.createdSessionId });
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || 'Error al registrarse');
    }
    setLoading(false);
  }, [email, password, isSignUpLoaded, signUp, setSignUpActive]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
      <Text style={styles.icon}>👁</Text>
      <Text style={styles.title}>ServerEyes</Text>
      <Text style={styles.subtitle}>Monitoreo de maquinas</Text>

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

        <TouchableOpacity
          style={styles.button}
          onPress={isRegistering ? handleSignUp : handleSignIn}
          disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#1a1a2e" />
          ) : (
            <Text style={styles.buttonText}>
              {isRegistering ? 'Crear cuenta' : 'Iniciar sesion'}
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => { setIsRegistering(!isRegistering); setError(''); }}>
          <Text style={styles.switchText}>
            {isRegistering ? 'Ya tengo cuenta' : 'Crear cuenta nueva'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', padding: 24 },
  icon: { fontSize: 60, textAlign: 'center', marginBottom: 10 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#00d4ff', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 4, marginBottom: 30 },
  form: {},
  input: {
    backgroundColor: '#16213e', borderWidth: 2, borderColor: '#2a2a4a',
    borderRadius: 12, padding: 14, fontSize: 16, color: '#eee', marginBottom: 12,
  },
  button: {
    backgroundColor: '#00d4ff', borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 8,
  },
  buttonText: { fontSize: 16, fontWeight: '700', color: '#1a1a2e' },
  error: { color: '#ff5252', textAlign: 'center', fontSize: 13, marginBottom: 8 },
  switchText: { color: '#00d4ff', textAlign: 'center', marginTop: 16, fontSize: 14 },
});
