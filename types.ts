
export interface TranscriptEntry {
  role: 'user' | 'helios' | 'system';
  text: string;
  timestamp: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface SystemStatus {
  cpu: number;
  memory: number;
  latency: number;
  visionActive: boolean;
}
