import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';

type RootStackParamList = {
  Home: undefined;
  Settings: undefined;
};

type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

interface Props {
  navigation: SettingsScreenNavigationProp;
}

export const SettingsScreen: React.FC<Props> = ({ navigation }) => {
  const [serverUrl, setServerUrl] = useState('http://100.89.247.64:8000');
  const [apiKey, setApiKey] = useState('');
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [confirmActions, setConfirmActions] = useState(true);

  const saveSettings = async () => {
    try {
      await SecureStore.setItemAsync('serverUrl', serverUrl);
      if (apiKey) {
        await SecureStore.setItemAsync('apiKey', apiKey);
      }
      await SecureStore.setItemAsync('autoSpeak', String(autoSpeak));
      await SecureStore.setItemAsync('confirmActions', String(confirmActions));
      Alert.alert('Success', 'Settings saved successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings');
    }
  };

  const loadSettings = async () => {
    try {
      const savedUrl = await SecureStore.getItemAsync('serverUrl');
      const savedKey = await SecureStore.getItemAsync('apiKey');
      const savedSpeak = await SecureStore.getItemAsync('autoSpeak');
      const savedConfirm = await SecureStore.getItemAsync('confirmActions');

      if (savedUrl) setServerUrl(savedUrl);
      if (savedKey) setApiKey(savedKey);
      if (savedSpeak !== null) setAutoSpeak(savedSpeak === 'true');
      if (savedConfirm !== null) setConfirmActions(savedConfirm === 'true');
    } catch (error) {
      console.log('Failed to load settings');
    }
  };

  React.useEffect(() => {
    loadSettings();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color="#007AFF" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={styles.content}>
        {/* Server Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Server</Text>
          
          <View style={styles.settingItem}>
            <Text style={styles.settingLabel}>Server URL</Text>
            <TextInput
              style={styles.textInput}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://your-server:8000"
              placeholderTextColor="#444"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.settingItem}>
            <Text style={styles.settingLabel}>API Key</Text>
            <TextInput
              style={styles.textInput}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="Enter your API key"
              placeholderTextColor="#444"
              secureTextEntry
            />
          </View>
        </View>

        {/* Voice Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Voice</Text>
          
          <View style={styles.settingRow}>
            <View>
              <Text style={styles.settingLabel}>Auto-speak responses</Text>
              <Text style={styles.settingDescription}>Automatically speak AI responses</Text>
            </View>
            <Switch
              value={autoSpeak}
              onValueChange={setAutoSpeak}
              trackColor={{ false: '#333', true: '#007AFF' }}
            />
          </View>

          <View style={styles.settingRow}>
            <View>
              <Text style={styles.settingLabel}>Confirm actions</Text>
              <Text style={styles.settingDescription}>Ask before executing commands</Text>
            </View>
            <Switch
              value={confirmActions}
              onValueChange={setConfirmActions}
              trackColor={{ false: '#333', true: '#007AFF' }}
            />
          </View>
        </View>

        {/* About */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.aboutItem}>
            <Text style={styles.aboutText}>SnapClaw v1.0.0</Text>
            <Text style={styles.aboutSubtext}>Voice-first orchestration layer above agents and model providers</Text>
          </View>
        </View>

        {/* Save Button */}
        <TouchableOpacity style={styles.saveButton} onPress={saveSettings}>
          <Text style={styles.saveButtonText}>Save Settings</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backText: {
    color: '#007AFF',
    fontSize: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  settingItem: {
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  settingLabel: {
    fontSize: 16,
    color: '#fff',
  marginBottom: 4,
  },
  settingDescription: {
    fontSize: 12,
    color: '#666',
  },
  textInput: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
    marginTop: 4,
  },
  aboutItem: {
    paddingVertical: 12,
  },
  aboutText: {
    fontSize: 16,
    color: '#fff',
  },
  aboutSubtext: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  saveButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 32,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default SettingsScreen;
