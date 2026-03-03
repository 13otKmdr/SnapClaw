// Error handling utility with user-friendly messages
export class NetworkError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ServerError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ServerError';
  }
}

export class WebSocketError extends Error {
  constructor(message: string, public code: number) {
    super(message);
    this.name = 'WebSocketError';
  }
}

export interface ErrorResponse {
  userMessage: string;
  technicalMessage: string;
  errorCode: string;
  isRetryable: boolean;
  retryAfterMs?: number;
}

export const ErrorHandler = {
  /**
   * Parse network errors and return user-friendly messages
   */
  parseNetworkError(error: unknown): ErrorResponse {
    if (error instanceof TypeError) {
      if (error.message.includes('Failed to fetch') || error.message.includes('Network request failed')) {
        return {
          userMessage: 'Unable to reach the server. Please check your internet connection and try again.',
          technicalMessage: error.message,
          errorCode: 'NETWORK_UNREACHABLE',
          isRetryable: true,
          retryAfterMs: 2000,
        };
      }
      if (error.message.includes('timeout')) {
        return {
          userMessage: 'The request took too long. Please check your connection and try again.',
          technicalMessage: error.message,
          errorCode: 'REQUEST_TIMEOUT',
          isRetryable: true,
          retryAfterMs: 3000,
        };
      }
    }

    if (error instanceof Error && error.message.includes('AbortError')) {
      return {
        userMessage: 'Request was cancelled. Please try again.',
        technicalMessage: error.message,
        errorCode: 'REQUEST_ABORTED',
        isRetryable: true,
        retryAfterMs: 1000,
      };
    }

    return {
      userMessage: 'An unexpected network error occurred. Please try again.',
      technicalMessage: String(error),
      errorCode: 'UNKNOWN_NETWORK_ERROR',
      isRetryable: true,
      retryAfterMs: 2000,
    };
  },

  /**
   * Parse HTTP response errors
   */
  parseHttpError(status: number, data: any): ErrorResponse {
    const detail = data?.detail || data?.message || '';

    if (status === 401 || status === 403) {
      return {
        userMessage: 'Your session has expired. Please log in again.',
        technicalMessage: detail || `Authentication failed (${status})`,
        errorCode: 'AUTH_FAILED',
        isRetryable: false,
      };
    }

    if (status === 400) {
      return {
        userMessage: detail || 'Invalid request. Please check your input and try again.',
        technicalMessage: detail || 'Bad request',
        errorCode: 'BAD_REQUEST',
        isRetryable: false,
      };
    }

    if (status === 404) {
      return {
        userMessage: 'The requested resource was not found.',
        technicalMessage: detail || 'Not found',
        errorCode: 'NOT_FOUND',
        isRetryable: false,
      };
    }

    if (status === 429) {
      return {
        userMessage: 'Too many requests. Please wait a moment and try again.',
        technicalMessage: detail || 'Rate limited',
        errorCode: 'RATE_LIMITED',
        isRetryable: true,
        retryAfterMs: 5000,
      };
    }

    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return {
        userMessage: 'The server is currently unavailable. Please try again in a moment.',
        technicalMessage: detail || `Server error (${status})`,
        errorCode: 'SERVER_ERROR',
        isRetryable: true,
        retryAfterMs: 5000,
      };
    }

    return {
      userMessage: `An error occurred (${status}). Please try again.`,
      technicalMessage: detail || `HTTP error ${status}`,
      errorCode: `HTTP_${status}`,
      isRetryable: status >= 500,
      retryAfterMs: status >= 500 ? 3000 : undefined,
    };
  },

  /**
   * Parse WebSocket errors
   */
  parseWebSocketError(code: number, reason?: string): ErrorResponse {
    const reasonStr = reason || '';

    if (code === 1000) {
      return {
        userMessage: 'Connection closed normally.',
        technicalMessage: reasonStr || 'Normal closure',
        errorCode: 'WS_NORMAL_CLOSURE',
        isRetryable: false,
      };
    }

    if (code === 1001) {
      return {
        userMessage: 'Connection lost. Attempting to reconnect...',
        technicalMessage: reasonStr || 'Going away',
        errorCode: 'WS_GOING_AWAY',
        isRetryable: true,
        retryAfterMs: 2000,
      };
    }

    if (code === 1002) {
      return {
        userMessage: 'Protocol error. Please restart the app.',
        technicalMessage: reasonStr || 'Protocol error',
        errorCode: 'WS_PROTOCOL_ERROR',
        isRetryable: false,
      };
    }

    if (code === 1003) {
      return {
        userMessage: 'Unsupported operation. Please restart the app.',
        technicalMessage: reasonStr || 'Unsupported data',
        errorCode: 'WS_UNSUPPORTED_DATA',
        isRetryable: false,
      };
    }

    if (code === 1006) {
      return {
        userMessage: 'Connection lost unexpectedly. Attempting to reconnect...',
        technicalMessage: reasonStr || 'Abnormal closure',
        errorCode: 'WS_ABNORMAL_CLOSURE',
        isRetryable: true,
        retryAfterMs: 3000,
      };
    }

    if (code === 1008) {
      return {
        userMessage: 'Invalid message format. Please try again.',
        technicalMessage: reasonStr || 'Policy violation',
        errorCode: 'WS_POLICY_VIOLATION',
        isRetryable: true,
        retryAfterMs: 2000,
      };
    }

    if (code === 1011) {
      return {
        userMessage: 'Server error. Please try again later.',
        technicalMessage: reasonStr || 'Server error',
        errorCode: 'WS_SERVER_ERROR',
        isRetryable: true,
        retryAfterMs: 5000,
      };
    }

    return {
      userMessage: 'Connection error. Please check your connection and try again.',
      technicalMessage: reasonStr || `WebSocket error code ${code}`,
      errorCode: `WS_ERROR_${code}`,
      isRetryable: true,
      retryAfterMs: 2000,
    };
  },

  /**
   * Parse backend unreachable errors
   */
  parseBackendUnreachableError(apiUrl: string): ErrorResponse {
    return {
      userMessage: 'Cannot connect to the server. Please check your network connection and ensure the server is running.',
      technicalMessage: `Backend at ${apiUrl} is unreachable`,
      errorCode: 'BACKEND_UNREACHABLE',
      isRetryable: true,
      retryAfterMs: 3000,
    };
  },

  /**
   * Get a user-friendly error message with optional suggestions
   */
  getUserFriendlyMessage(error: ErrorResponse): string {
    let message = error.userMessage;

    if (error.isRetryable && error.errorCode !== 'AUTH_FAILED') {
      message += ' You can try again.';
    }

    if (error.errorCode === 'AUTH_FAILED') {
      message += ' Please log in again.';
    }

    if (error.errorCode === 'NETWORK_UNREACHABLE') {
      message += ' Make sure WiFi or mobile data is enabled.';
    }

    return message;
  },
};
