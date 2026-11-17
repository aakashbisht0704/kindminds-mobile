/**
 * 72-hour kit checklist.
 *
 * The list is the standard household preparedness set used by IFRC and most
 * national disaster agencies, tightened for a single phone-sized app: only items
 * an individual can actually carry and pack in one evening.
 */

export type KitItem = {
  id: string;
  label: string;
  /** Why it is on the list. Shown under the label, never hidden behind a tap. */
  why: string;
  group: KitGroup;
};

export type KitGroup = 'water' | 'food' | 'light-power' | 'medical' | 'documents' | 'shelter' | 'comms';

export const GROUP_LABELS: Record<KitGroup, string> = {
  water: 'Water',
  food: 'Food',
  'light-power': 'Light and power',
  medical: 'Medical',
  documents: 'Documents and money',
  shelter: 'Warmth and shelter',
  comms: 'Comms and info',
};

export const KIT_ITEMS: readonly KitItem[] = [
  { id: 'water-3l', label: '3 litres of water per person per day, for 3 days', why: 'A person needs about 3 litres a day to drink and stay clean.', group: 'water' },
  { id: 'water-filter', label: 'Water purification tablets or a filter', why: 'After a disaster, the tap water is the first thing to fail.', group: 'water' },
  { id: 'food-3d', label: '3 days of food that needs no cooking', why: 'Gas and power are usually out, and cooking smells attract attention.', group: 'food' },
  { id: 'can-opener', label: 'Manual can opener', why: 'Cans are useless without one, and they are always forgotten.', group: 'food' },
  { id: 'torch', label: 'Torch or head torch with spare batteries', why: 'Most injuries in a blackout happen on stairs and in rubble.', group: 'light-power' },
  { id: 'powerbank', label: 'Charged power bank and cable', why: 'Your phone is your map, torch, radio and SOS all at once.', group: 'light-power' },
  { id: 'radio', label: 'Battery or wind-up radio', why: 'Official warnings still arrive by broadcast radio when networks fail.', group: 'light-power' },
  { id: 'first-aid', label: 'First aid kit with dressings and tape', why: 'You will treat cuts and crush injuries long before a medic arrives.', group: 'medical' },
  { id: 'meds', label: '7 days of your own medication', why: 'Pharmacies close and supply chains break in the first week.', group: 'medical' },
  { id: 'gloves', label: 'Work gloves and sturdy shoes by the bed', why: 'Glass and nails are the most common injury in a collapsed building.', group: 'medical' },
  { id: 'docs', label: 'ID, insurance and medical papers, waterproof bag', why: 'You cannot claim relief or cross a checkpoint without identification.', group: 'documents' },
  { id: 'cash', label: 'Cash in small notes', why: 'Card machines and ATMs are down exactly when you need them.', group: 'documents' },
  { id: 'contacts', label: 'Emergency contacts written on paper', why: 'A phone with a dead battery cannot show you a phone number.', group: 'documents' },
  { id: 'blanket', label: 'Foil blanket or warm layer per person', why: 'Most disaster deaths after the event are from exposure, not the event.', group: 'shelter' },
  { id: 'whistle', label: 'Whistle', why: 'A whistle carries further than a voice and costs no energy.', group: 'shelter' },
  { id: 'dust-mask', label: 'Dust masks, N95 if you can', why: 'Collapse dust and wildfire smoke damage lungs within hours.', group: 'shelter' },
  { id: 'map', label: 'Offline map pack installed in this app', why: 'This is the only map that still works when the network is gone.', group: 'comms' },
  { id: 'plan', label: 'Agreed meeting point with your household', why: 'Agree it now: phones fail and people cannot coordinate in the moment.', group: 'comms' },
] as const;

export const KIT_GROUPS: readonly KitGroup[] = [
  'water', 'food', 'light-power', 'medical', 'documents', 'shelter', 'comms',
] as const;

export function kitProgress(packed: Record<string, boolean>): { packed: number; total: number; ratio: number } {
  const total = KIT_ITEMS.length;
  const count = KIT_ITEMS.filter((item) => packed[item.id] === true).length;
  return { packed: count, total, ratio: total === 0 ? 0 : count / total };
}
