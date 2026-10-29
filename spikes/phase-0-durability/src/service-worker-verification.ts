// Story 1.4 (Gate B) — client-side driver for the nonce-bound MessageChannel handshake against
// certification-service-worker.ts. Feeds certification-grant.ts's controllerVerification input.
// Fails closed (never throws past the caller) on first-load, no-controller, or any ambiguous state.
import type { ServiceWorkerVerificationResult } from './certification-grant';
import type { HandshakeAck } from './certification-service-worker';

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mapRegistrationState(registration: ServiceWorkerRegistration | undefined): ServiceWorkerVerificationResult['state'] | null {
  if (!registration) return 'uncontrolled';
  if (registration.installing) return 'installing';
  if (registration.waiting) return 'waiting';
  // registration.active with no controller means this document loaded before the SW took
  // control (first-load) — that is 'uncontrolled', not 'activated-controlling'.
  return null;
}

export async function requestServiceWorkerVerification(timeoutMs = 5000): Promise<ServiceWorkerVerificationResult> {
  if (!('serviceWorker' in navigator)) return { state: 'uncontrolled', manifestRoot: null };
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const preState = mapRegistrationState(registration);
  if (preState) return { state: preState, manifestRoot: null };

  const controller = navigator.serviceWorker.controller;
  if (!controller) return { state: 'uncontrolled', manifestRoot: null };
  if (registration?.active && controller !== registration.active) {
    // Redundant: this document's controller no longer matches the registration's active worker.
    return { state: 'redundant', manifestRoot: null };
  }

  const nonce = randomNonce();
  const channel = new MessageChannel();
  const ack = await new Promise<HandshakeAck | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data as HandshakeAck);
    };
    controller.postMessage({ type: 'CERTIFY_HANDSHAKE', nonce }, [channel.port2]);
  });

  // Replay/mismatch protection: an ack for a different nonce, a missing ack, or a withheld
  // manifestRoot (self-verification failed) all fail closed.
  if (!ack || ack.nonce !== nonce || !ack.manifestRoot) return { state: 'uncontrolled', manifestRoot: null };
  return { state: 'activated-controlling', manifestRoot: ack.manifestRoot };
}
