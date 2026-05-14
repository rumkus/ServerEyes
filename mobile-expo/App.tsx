import React from 'react';
import { ClerkProvider, SignedIn, SignedOut, ClerkLoaded } from '@clerk/clerk-expo';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SecureStore from 'expo-secure-store';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';

const CLERK_PUBLISHABLE_KEY = 'pk_test_c29saWQteWFrLTgyLmNsZXJrLmFjY291bnRzLmRldiQ';

const tokenCache = {
  async getToken(key: string) {
    try { return await SecureStore.getItemAsync(key); }
    catch { return null; }
  },
  async saveToken(key: string, value: string) {
    try { await SecureStore.setItemAsync(key, value); }
    catch {}
  },
};

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <ClerkLoaded>
        <NavigationContainer>
          <SignedOut>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Login" component={LoginScreen} />
            </Stack.Navigator>
          </SignedOut>
          <SignedIn>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Home" component={HomeScreen} />
            </Stack.Navigator>
          </SignedIn>
        </NavigationContainer>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
