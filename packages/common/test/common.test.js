import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudEvent, EVENTS, envMap } from '../src/index.js';

test('un événement respecte le format CloudEvents 1.0', () => {
  const e = cloudEvent(EVENTS.COMMANDE_RESERVEE, 'commandes', { id: 1 });
  assert.equal(e.specversion, '1.0');
  assert.equal(e.type, 'com.surfwear.commande.reservee');
  assert.equal(e.source, '/surfwear/commandes');
  assert.ok(e.id && e.time);
});

test('envMap lit une liste clé:valeur', () => {
  process.env.TEST_MAP = 'B001:a@b.fr, B002:c@d.fr';
  assert.deepEqual(envMap('TEST_MAP'), { B001: 'a@b.fr', B002: 'c@d.fr' });
});
