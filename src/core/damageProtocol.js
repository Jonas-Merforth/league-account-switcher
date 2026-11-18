import * as fields16_22 from './damagePacketFields16_22.js';
import * as fields16_23 from './damagePacketFields16_23.js';

export const damageProtocol16_22 = Object.freeze({
  fields: fields16_22,
  combat: 743,
  batch: 1045,
  ownerAction: 618,
  heroSpawn: 43,
  recap: 1074,
  recapOwner: 419,
  heroStats: 664,
  display: 393,
  secondaryTimestamp: false
});

const damageProtocol16_23 = Object.freeze({
  fields: fields16_23,
  combat: 172,
  batch: 314,
  ownerAction: 693,
  heroSpawn: 88,
  recap: 502,
  recapOwner: 408,
  heroStats: 313,
  display: 530,
  secondaryTimestamp: true
});

export const damageProtocols = new Map([
  ['16.22.8348910', damageProtocol16_22],
  ['16.23.8396405', damageProtocol16_23]
]);
