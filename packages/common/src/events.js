import { randomUUID } from 'node:crypto';

// Types d'événements métier (format CloudEvents 1.0, voir docs/asyncapi.yaml).
export const EVENTS = {
  STOCK_MIS_A_JOUR: 'com.surfwear.stock.mis-a-jour',
  COMMANDE_CREEE: 'com.surfwear.commande.creee',
  COMMANDE_RESERVEE: 'com.surfwear.commande.reservee',
  COMMANDE_EXPEDIEE: 'com.surfwear.commande.expediee',
};

export function cloudEvent(type, source, data, id = randomUUID()) {
  return {
    specversion: '1.0',
    id,
    source: `/surfwear/${source}`,
    type,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data,
  };
}
