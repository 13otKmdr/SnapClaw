import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import HomeScreen from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { VoiceProvider } from './src/hooks/useVoice';
import { configureWebAppShell, registerWebServiceWorker } from './src/utils/webApp';

const Stack = createNativeStackNavigator();

export default function App() {
  React.useEffect(() => {
    configureWebAppShell();
    void registerWebServiceWorker();
  }, []);

  return (
    <SafeAreaProvider>
      <VoiceProvider>
        <NavigationContainer>
          <StatusBar style="light" />
          <Stack.Navigator 
            initialRouteName="Home"
            screenOptions={{
              headerStyle: { backgroundColor: '#0a0a0a' },
              headerTintColor: '#fff',
              contentStyle: { backgroundColor: '#0a0a0a' },
            }}
          >
            <Stack.Screen 
              name="Home" 
              component={HomeScreen}
              options={{ title: 'SnapClaw' }}
            />
            <Stack.Screen 
              name="Settings" 
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </VoiceProvider>
    </SafeAreaProvider>
  );
}
