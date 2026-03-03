// Authentication Service
import * as SecureStore from 'expo-secure-store';
import { getApiBaseUrl } from './baseUrl';

const API_URL = getApiBaseUrl();

export interface User {
  id: string;
  email: string;
  username: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export class AuthService {
  private static TOKEN_KEY = 'auth_token';
  private static USER_KEY = 'user_data';

  static async register(email: string, username: string, password: string): Promise<AuthResponse> {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Registration failed');
    }

    const data: AuthResponse = await response.json();
    await this.saveToken(data.access_token);
    await this.saveUser(data.user);
    return data;
  }

  static async login(email: string, password: string): Promise<AuthResponse> {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      throw new Error('Invalid credentials');
    }

    const data: AuthResponse = await response.json();
    await this.saveToken(data.access_token);
    await this.saveUser(data.user);
    return data;
  }

  static async logout(): Promise<void> {
    await SecureStore.deleteItemAsync(this.TOKEN_KEY);
    await SecureStore.deleteItemAsync(this.USER_KEY);
  }

  static async getToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(this.TOKEN_KEY);
  }

  static async getUser(): Promise<User | null> {
    const userJson = await SecureStore.getItemAsync(this.USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
  }

  static async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  static async saveToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(this.TOKEN_KEY, token);
  }

  static async saveUser(user: User): Promise<void> {
    await SecureStore.setItemAsync(this.USER_KEY, JSON.stringify(user));
  }
}
