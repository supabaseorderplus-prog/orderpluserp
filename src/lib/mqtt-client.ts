/**
 * MQTT Client — browser-side, WebSocket transport
 *
 * Broker: HiveMQ public broker (free, no account needed)
 * URL:    wss://broker.hivemq.com:8884/mqtt
 *
 * Topic structure:
 *   PUBLISH  hometech/location/{salesman_id}
 *   SUBSCRIBE hometech/location/+     (all salesmen)
 *
 * Replace BROKER_URL with your own HiveMQ Cloud or Mosquitto broker for production.
 */

import mqtt, { type MqttClient } from "mqtt";

const BROKER_URL = "wss://broker.hivemq.com:8884/mqtt";
export const LOCATION_TOPIC_PREFIX = "hometech/location";

export interface MqttLocationPayload {
  salesman_id: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  battery_level?: number | null;
  recorded_at: string;
}

let _client: MqttClient | null = null;

/** Returns a singleton MQTT client (browser only). */
export function getMqttClient(): MqttClient {
  if (_client && _client.connected) return _client;

  _client = mqtt.connect(BROKER_URL, {
    clientId: `hometech-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    keepalive: 60,
    protocolVersion: 5,
  });

  _client.on("error", (err) => {
    console.warn("[MQTT] connection error:", err.message);
  });

  return _client;
}

/** Publish a single location update. Fire-and-forget. */
export function publishLocation(payload: MqttLocationPayload): void {
  try {
    const client = getMqttClient();
    const topic = `${LOCATION_TOPIC_PREFIX}/${payload.salesman_id}`;
    client.publish(topic, JSON.stringify(payload), { qos: 0, retain: false });
  } catch (err) {
    console.warn("[MQTT] publish failed:", err);
  }
}

/** Disconnect the singleton client (call on page unmount if desired). */
export function disconnectMqtt(): void {
  _client?.end(true);
  _client = null;
}
