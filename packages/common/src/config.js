// Lecture centralisée des variables d'environnement.
export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
    return fallback;
  }
  return v;
}

export function envInt(name, fallback) {
  return parseInt(env(name, String(fallback)), 10);
}

// "B001:valeur,B002:valeur" -> { B001: 'valeur', B002: 'valeur' }
export function envMap(name) {
  const raw = process.env[name] || '';
  return Object.fromEntries(
    raw.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf(':');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
