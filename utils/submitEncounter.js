// utils/submitEncounter.js
import axios from "axios";

/**
 * Build a Backport Subscription Notification Bundle carrying one Encounter.
 * You can tweak subscription URL/topic via options.
 */
export function buildNotificationBundle(encounter, {
  subscriptionUrl = "http://ecr.drajer.com/secure/fhir-r4/fhir/Subscription/encounter-end",
  topicCanonical = "http://hl7.org/fhir/us/medmorph/SubscriptionTopic/encounter-end",
  eventsSinceStart = 1,
  eventsInNotification = 1
} = {}) {
  const nowIso = new Date().toISOString();

  // Stable URN for Parameters entry
  const paramsUrn = "urn:uuid:" + cryptoRandomUuid();

  return {
    resourceType: "Bundle",
    id: "notification-full-resource",
    meta: {
      lastUpdated: nowIso,
      profile: [
        "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-subscription-notification"
      ]
    },
    type: "history",
    timestamp: nowIso,
    entry: [
      {
        fullUrl: paramsUrn,
        resource: {
          resourceType: "Parameters",
          id: paramsUrn.split(":").pop(),
          meta: {
            lastUpdated: nowIso,
            profile: [
              "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-subscriptionstatus"
            ]
          },
          parameter: [
            { name: "subscription", valueReference: { reference: subscriptionUrl } },
            { name: "topic",        valueCanonical: topicCanonical },
            { name: "type",         valueCode: "event-notification" },
            { name: "status",       valueCode: "active" },
            { name: "events-since-subscription-start", valueUnsignedInt: Number(eventsSinceStart) },
            { name: "events-in-notification",          valueUnsignedInt: Number(eventsInNotification) }
          ]
        },
        request: { method: "GET", url: `${subscriptionUrl}/$status` },
        response: { status: "200" }
      },
      {
        // Use the Encounter's absolute or relative URL if you have one; relative is fine.
        fullUrl: encounter.id?.startsWith("Encounter/")
          ? encounter.id
          : `Encounter/${encounter.id || "unknown"}`,
        resource: encounter
      }
    ]
  };
}

/**
 * POST the notification bundle to receive-notification.
 * auth: { type: 'bearer'|'basic'|'none', token: '...' }
 */
export async function submitEncounter({ url, encounter, auth, bundleOptions }) {
  const bundle = buildNotificationBundle(encounter, bundleOptions);

  const headers = {
    "Content-Type": "application/fhir+json",
    "X-Request-ID": 1234,
    Accept: "application/fhir+json"
  };
  if (auth?.type === "bearer") headers.Authorization = `Bearer ${auth.token}`;
  if (auth?.type === "basic")  headers.Authorization = auth.token;

  const resp = await axios.post(url, bundle, { headers, timeout: 30000 });
  return resp.data;
}

/** Small UUID helper without extra deps */
function cryptoRandomUuid() {
  // Node 16+: crypto.randomUUID() exists; fallback below if needed.
  try {
    return crypto.randomUUID();
  } catch {
    // RFC4122 v4-ish fallback
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}