// utils/fhirQueries.js
import axios from 'axios';

/**
 * Build a single FHIR code param value from CSV:
 *   "system|code,system|code"  (OR semantics)
 */
function buildCodeParam(codesCsv) {
  return (codesCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .join(',');
}

/**
 * POST /Condition/_search to find Conditions by code (and optional date window),
 * include the linked Encounter (and optionally Patient), then return unique Encounters.
 *
 * If the server does not return included Encounters, it falls back to fetching
 * Encounter/{id} from each Condition.encounter.reference.
 *
 * @param {object} opts
 * @param {string} opts.fhirBase             - FHIR base URL (no trailing slash)
 * @param {string} opts.token                - Bearer token for the FHIR server
 * @param {string} [opts.start]              - ISO date (e.g. "2025-08-01") for lower bound
 * @param {string} [opts.end]                - ISO date for upper bound
 * @param {string} [opts.dateField]          - One of "recorded-date" | "onset-date" | "_lastUpdated" (default "recorded-date")
 * @param {string} [opts.codesCsv]           - CSV of codes "system|code,system|code"
 * @param {boolean} [opts.includePatient]    - Whether to include Patient (default true)
 * @param {number} [opts.count]              - Page size (default 100)
 * @returns {Promise<Array>}                 - Array of Encounter resources
 */
export async function fetchEncountersByConditionCodesPost({
  fhirBase,
  token,
  start,
  end,
  dateField,
  codesCsv = '',
  includePatient = true,
  count = 100
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/fhir+json',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const encounters = new Map(); // id -> Encounter

  // Build initial POST body
  const form = new URLSearchParams();
  const codeParam = buildCodeParam(codesCsv);
  if (codeParam) form.append('code', codeParam);

  // Add date filters if provided
  // If you hit 400 with "not supported" for this combo, try dateField = 'onset-date' or '_lastUpdated'.
  if (start) form.append(dateField, `ge${start}`);
  if (end) form.append(dateField, `le${end}`);

  form.append('_include', 'Condition:encounter');
  if (includePatient) form.append('_include', 'Condition:subject');
  form.append('_count', String(count));

  // 1) POST /Condition/_search
  const searchUrl = `${fhirBase}/Condition/_search`;
  let bundle = await axios
    .post(searchUrl, form.toString(), { headers, timeout: 30000 })
    .then(r => r.data);

    // Count and log Conditions
    if (bundle.resourceType === 'Bundle' && Array.isArray(bundle.entry)) {
        const conditions = bundle.entry.filter(
            e => e.resource.resourceType === 'Condition'
        );

        console.log(`\n[INFO] Found ${conditions.length} Condition(s)`);
        // Extract encounter refs from the Conditions we just logged
        const encounterRefs = conditions
            .map(c => c.resource?.encounter?.reference)            // e.g., "Encounter/123"
            .filter(ref => typeof ref === 'string' && ref.startsWith('Encounter/'));

        console.log(`[INFO] Conditions referencing encounters: ${encounterRefs.length}`);
        if (encounterRefs.length === 0) {
            console.log('[WARN] No Condition.encounter references present. Either the data lacks links or include is unsupported.');
        }

        // Fetch each referenced Encounter if we haven't harvested any (or to fill gaps)
        for (const ref of encounterRefs) {
            const encId = ref.split('/')[1];
            if (!encId) continue;
            if (encounters.has(encId)) continue; // you already have this from _include

            try {
                const enc = await axios.get(`${fhirBase}/Encounter/${encId}`, {
                    headers,
                    timeout: 20000,
                }).then(r => r.data);

                if (enc?.resourceType === 'Encounter' && enc.id) {
                    encounters.set(enc.id, enc);
                    console.log(`[INFO] Pulled Encounter/${enc.id} via direct GET (fallback).`);
                } else {
                    console.log(`[WARN] GET ${ref} returned non-Encounter or missing id.`);
                }
            } catch (e) {
                console.log(`[ERROR] Failed to fetch ${ref}:`, e.response?.status, e.response?.data || e.message);
            }
        }

        console.log(`[INFO] Total Encounters collected (includes + fallback): ${encounters.size}`);
    }

  // Helper to harvest included Encounters from a bundle
  const harvestEncounters = b => {
    (b.entry || []).forEach(e => {
      const res = e.resource;
      if (res?.resourceType === 'Encounter' && res.id) {
        encounters.set(res.id, res);
      }
    });
  };

  harvestEncounters(bundle);

  // 2) Follow pagination using server-provided next link (usually safe, contains _getpages)
  let next = (bundle.link || []).find(l => l.relation === 'next')?.url || null;
  while (next) {
    const b = await axios.get(next, { headers, timeout: 30000 }).then(r => r.data);
    harvestEncounters(b);
    next = (b.link || []).find(l => l.relation === 'next')?.url || null;
  }

  // 3) Fallback: if no Encounters were included, fetch via Condition.encounter.reference
  if (encounters.size === 0) {
    // Re-run a lightweight search (without includes) to collect Condition refs
    const fallbackForm = new URLSearchParams();
    if (codeParam) fallbackForm.append('code', codeParam);
    if (start) fallbackForm.append(dateField, `ge${start}`);
    if (end) fallbackForm.append(dateField, `le${end}`);
    fallbackForm.append('_count', String(count));

    let b = await axios
      .post(`${fhirBase}/Condition/_search`, fallbackForm.toString(), { headers, timeout: 30000 })
      .then(r => r.data);

    const fetchEncounterByRef = async ref => {
      // ref like "Encounter/123"
      if (!ref?.startsWith('Encounter/')) return;
      const id = ref.split('/')[1];
      if (!id || encounters.has(id)) return;
      const enc = await axios
        .get(`${fhirBase}/Encounter/${id}`, { headers, timeout: 20000 })
        .then(r => r.data)
        .catch(() => null);
      if (enc?.resourceType === 'Encounter' && enc.id) encounters.set(enc.id, enc);
    };

    const processBundleConditions = async bundlePage => {
      for (const entry of bundlePage.entry || []) {
        const res = entry.resource;
        if (res?.resourceType === 'Condition') {
          const encRef = res?.encounter?.reference;
          await fetchEncounterByRef(encRef);
        }
      }
    };

    await processBundleConditions(b);

    let next2 = (b.link || []).find(l => l.relation === 'next')?.url || null;
    while (next2) {
      b = await axios.get(next2, { headers, timeout: 30000 }).then(r => r.data);
      await processBundleConditions(b);
      next2 = (b.link || []).find(l => l.relation === 'next')?.url || null;
    }
  }

  return Array.from(encounters.values());
}
