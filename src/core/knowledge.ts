/**
 * The offline knowledge base.
 *
 * This is the part of the app that must be right. Every entry is written to be
 * usable by a frightened non-medic at night with one bar of battery: short
 * imperative steps, no jargon, and an explicit "stop and get help" line where a
 * procedure can go wrong. Content follows the IFRC / WHO / Sphere guidance that
 * humanitarian responders are trained on; it is deliberately conservative.
 *
 * Nothing here calls a network or a model. The on-device assistant retrieves
 * from these records and can only add phrasing on top.
 */

export type TopicId =
  | 'bleeding'
  | 'cpr'
  | 'breathing'
  | 'shock'
  | 'fracture'
  | 'burns'
  | 'head-injury'
  | 'hypothermia'
  | 'heat'
  | 'choking'
  | 'water'
  | 'food'
  | 'shelter'
  | 'fire'
  | 'sanitation'
  | 'earthquake'
  | 'flood'
  | 'cyclone'
  | 'wildfire'
  | 'panic'
  | 'grief'
  | 'grounding'
  | 'sleep'
  | 'anger'
  | 'loneliness'
  | 'children'
  | 'signal'
  | 'power';

export type KnowledgeEntry = {
  id: TopicId;
  title: string;
  /** Grouping for the browse UI. */
  domain: 'medical' | 'water-food' | 'shelter' | 'hazard' | 'mind' | 'comms';
  /** One-line answer shown before the steps. */
  summary: string;
  /** Ordered actions. Steps flagged `critical` are read aloud first. */
  steps: { text: string; critical?: boolean }[];
  /** Hard limits. Shown in hazard colour, never collapsed. */
  never: string[];
  /** Extra search terms, including plain-language ones people actually type. */
  keywords: string[];
  /** Hours of relevance, used to rank urgent topics first. */
  urgency: 1 | 2 | 3;
};

export const KNOWLEDGE_BASE: readonly KnowledgeEntry[] = [
  {
    id: 'bleeding',
    title: 'Severe bleeding',
    domain: 'medical',
    summary: 'Press hard on the wound and do not lift to check.',
    steps: [
      { text: 'Put a cloth or clean pad directly on the wound.', critical: true },
      { text: 'Press down hard with both hands and keep pressing.', critical: true },
      { text: 'If blood soaks through, add another pad on top. Do not remove the first one.' },
      { text: 'Lay the person flat and lift the injured limb above heart level if you can.' },
      { text: 'Keep pressing for at least 10 minutes before looking.' },
      { text: 'If bleeding will not stop, press the artery above the wound with a finger.' },
    ],
    never: [
      'Do not use a tourniquet unless a limb is crushed or bleeding cannot be stopped by pressure.',
      'Do not remove an object stuck in the wound. Press around it.',
    ],
    keywords: ['bleed', 'blood', 'cut', 'wound', 'haemorrhage', 'hemorrhage', 'pressure', 'tourniquet'],
    urgency: 3,
  },
  {
    id: 'cpr',
    title: 'Not breathing (CPR)',
    domain: 'medical',
    summary: 'If they are not breathing normally, start chest compressions now.',
    steps: [
      { text: 'Shout for help. Tap their shoulders and ask loudly if they are okay.', critical: true },
      { text: 'Tilt the head back and check for normal breathing for 10 seconds.', critical: true },
      { text: 'Not breathing normally: place the heel of your hand on the centre of the chest.', critical: true },
      { text: 'Push hard and fast, 5 to 6 cm deep, 100 to 120 times a minute.', critical: true },
      { text: 'Let the chest come all the way back up between pushes.' },
      { text: 'If trained, give 2 rescue breaths after every 30 compressions.' },
      { text: 'Swap with another person every 2 minutes. Do not stop until help arrives.' },
    ],
    never: [
      'Do not stop to check for a pulse if you are unsure.',
      'Do not give up because you are not trained. Compressions alone save lives.',
    ],
    keywords: ['cpr', 'not breathing', 'unconscious', 'collapse', 'resuscitate', 'chest compression', 'drowning'],
    urgency: 3,
  },
  {
    id: 'breathing',
    title: 'Trouble breathing',
    domain: 'medical',
    summary: 'Sit them upright, loosen clothing, keep the air moving.',
    steps: [
      { text: 'Sit the person upright. Do not lay them flat.', critical: true },
      { text: 'Loosen tight clothing at the neck and chest.' },
      { text: 'Move them away from smoke, dust and fumes.' },
      { text: 'If they have an inhaler, help them use it.' },
      { text: 'Ask them to breathe out slowly through pursed lips.' },
      { text: 'If lips or fingertips turn blue, this is an emergency. Get help now.', critical: true },
    ],
    never: ['Do not leave someone with blue lips alone.', 'Do not give food or drink while they struggle to breathe.'],
    keywords: ['breathe', 'breathing', 'asthma', 'smoke', 'dust', 'suffocate', 'inhaler', 'wheeze', 'blue lips'],
    urgency: 3,
  },
  {
    id: 'shock',
    title: 'Shock after injury',
    domain: 'medical',
    summary: 'Pale, cold, clammy and confused after injury means shock.',
    steps: [
      { text: 'Lay them flat and raise the legs about 30 cm.', critical: true },
      { text: 'Stop any bleeding first.', critical: true },
      { text: 'Keep them warm with a blanket, coat or foil sheet.' },
      { text: 'Do not give food or drink.' },
      { text: 'Reassure them and stay with them, talking calmly.' },
      { text: 'Check breathing every few minutes.' },
    ],
    never: ['Do not raise the legs if the head, spine, hip or leg is injured.', 'Do not give anything by mouth.'],
    keywords: ['shock', 'pale', 'clammy', 'faint', 'dizzy', 'weak pulse', 'collapse'],
    urgency: 3,
  },
  {
    id: 'fracture',
    title: 'Broken bone',
    domain: 'medical',
    summary: 'Support it in the position you found it. Do not straighten it.',
    steps: [
      { text: 'Do not move the limb. Support it with your hands.', critical: true },
      { text: 'Do not try to push bone back in or straighten a deformity.', critical: true },
      { text: 'Pad either side with cloth, then a rigid splint (board, stick, rolled magazine).' },
      { text: 'Bind the splint above and below the break. Check fingers or toes stay warm and pink.' },
      { text: 'For an arm, support it in a sling against the chest.' },
      { text: 'Apply cold to reduce swelling, never directly on skin.' },
    ],
    never: ['Do not straighten the limb.', 'Do not let them walk on a suspected broken leg or hip.'],
    keywords: ['broken', 'fracture', 'bone', 'splint', 'arm', 'leg', 'sprain', 'dislocated'],
    urgency: 2,
  },
  {
    id: 'burns',
    title: 'Burns',
    domain: 'medical',
    summary: 'Cool with clean running water for 20 minutes. Never use ice or paste.',
    steps: [
      { text: 'Remove from the heat source and stop the burning process.', critical: true },
      { text: 'Cool the burn with clean cool running water for 20 minutes.', critical: true },
      { text: 'Remove jewellery and loose clothing near the burn before it swells. Do not pull cloth stuck to skin.' },
      { text: 'Cover with cling film or a clean, non-fluffy cloth.' },
      { text: 'Keep the person warm while cooling the burn. Do not cool a large area for too long.' },
      { text: 'Burns on face, hands, joints, or larger than their palm need professional care.', critical: true },
    ],
    never: [
      'No ice, butter, toothpaste, oil or ash on a burn.',
      'Do not burst blisters.',
      'Do not use cotton wool.',
    ],
    keywords: ['burn', 'scald', 'fire', 'hot water', 'blister', 'smoke burn'],
    urgency: 3,
  },
  {
    id: 'head-injury',
    title: 'Head injury',
    domain: 'medical',
    summary: 'Watch for vomiting, sleepiness or unequal pupils. That needs a hospital.',
    steps: [
      { text: 'Keep the head and neck still. Do not twist the neck.', critical: true },
      { text: 'Stop any bleeding with gentle pressure around, not on, the wound.' },
      { text: 'Watch for: vomiting, worsening sleepiness, confusion, unequal pupils, clear fluid from nose or ear.', critical: true },
      { text: 'If awake, sit them up slightly and keep them warm.' },
      { text: 'Wake them every hour through the night to check they respond normally.' },
    ],
    never: [
      'Do not let them sleep unattended right after a head injury.',
      'Do not press on a dented skull.',
    ],
    keywords: ['head', 'concussion', 'skull', 'unconscious', 'vomiting', 'pupil', 'brain', 'spine', 'neck'],
    urgency: 3,
  },
  {
    id: 'hypothermia',
    title: 'Hypothermia (cold)',
    domain: 'medical',
    summary: 'Warm the middle of the body slowly. Handle them gently.',
    steps: [
      { text: 'Move them out of wind and rain. Handle gently, shocking the body can stop the heart.', critical: true },
      { text: 'Remove wet clothing by cutting it off if needed.' },
      { text: 'Wrap the whole body including the head in dry layers or a foil blanket.' },
      { text: 'Warm the chest, neck and groin first, with your own body heat or warm (not hot) objects.' },
      { text: 'Give warm sweet drinks only if fully awake and able to swallow.' },
      { text: 'Do not rub the limbs or give alcohol.' },
    ],
    never: ['No alcohol.', 'Do not put them in hot water.', 'Do not rub arms and legs.'],
    keywords: ['cold', 'hypothermia', 'shivering', 'freezing', 'wet', 'warm up', 'frostbite'],
    urgency: 3,
  },
  {
    id: 'heat',
    title: 'Heat exhaustion and heatstroke',
    domain: 'medical',
    summary: 'Confusion plus hot dry skin is heatstroke, which kills fast.',
    steps: [
      { text: 'Move to shade. Remove excess clothing.', critical: true },
      { text: 'Confused, fitting or unconscious with hot skin means heatstroke. Cool them immediately.', critical: true },
      { text: 'Pour cool water over the body and fan them, especially neck, armpits and groin.' },
      { text: 'Give sips of water with a pinch of salt and sugar if fully awake.' },
      { text: 'Keep cooling until they are alert and their skin is cool.' },
    ],
    never: ['Do not give drinks to an unconscious person.', 'Do not leave a child or elderly person in a parked vehicle.'],
    keywords: ['heat', 'heatstroke', 'heatwave', 'sun', 'dehydration', 'hot', 'dizzy', 'cramp'],
    urgency: 2,
  },
  {
    id: 'choking',
    title: 'Choking',
    domain: 'medical',
    summary: 'Five back blows, then five abdominal thrusts. Repeat.',
    steps: [
      { text: 'If they can cough, encourage coughing. Do not hit them yet.', critical: true },
      { text: 'Cannot cough, speak or breathe: give 5 sharp back blows between the shoulder blades.', critical: true },
      { text: 'Then 5 abdominal thrusts just above the navel, pulling inwards and upwards.', critical: true },
      { text: 'Repeat 5 and 5. Call for help.', critical: true },
      { text: 'If they become unresponsive, start CPR.' },
    ],
    never: ['Do not put your fingers in the throat unless you can clearly see the object.', 'No abdominal thrusts on a baby under 1 year.'],
    keywords: ['choke', 'choking', 'blocked airway', 'swallowed', 'cannot breathe'],
    urgency: 3,
  },
  {
    id: 'water',
    title: 'Safe drinking water',
    domain: 'water-food',
    summary: 'Boil for 1 minute, or 30 minutes of sunlight, or chlorine.',
    steps: [
      { text: 'Prefer bottled or sealed water if any is available.', critical: true },
      { text: 'Cloudy water: let it settle, then filter through clean cloth before disinfecting.', critical: true },
      { text: 'Boil: rolling boil for 1 minute (3 minutes above 2000 m), then cool covered.', critical: true },
      { text: 'Or add 2 drops of plain unscented bleach per litre, wait 30 minutes.' },
      { text: 'Or fill clear plastic bottles and lay in full sun for 6 hours (SODIS).' },
      { text: 'Store in a covered container. Pour out, do not dip cups in.', critical: true },
    ],
    never: [
      'Never drink floodwater or water that smells of fuel or chemicals. Boiling will not remove chemicals.',
      'Do not use scented bleach or bleach with additives.',
    ],
    keywords: ['water', 'drink', 'thirst', 'boil', 'purify', 'clean water', 'bleach', 'chlorine', 'sodis', 'filter'],
    urgency: 3,
  },
  {
    id: 'food',
    title: 'Food when supplies are low',
    domain: 'water-food',
    summary: 'Eat what spoils first, ration calories, never food touched by floodwater.',
    steps: [
      { text: 'Throw away anything touched by floodwater, and anything swollen, leaking or foul-smelling.', critical: true },
      { text: 'Eat refrigerated food first: it spoils within 4 hours without power.', critical: true },
      { text: 'Cook dried food early while fuel lasts. Cooked food keeps about 2 hours.' },
      { text: 'Adults can survive weeks without food but only days without water. Prioritise water.', critical: true },
      { text: 'Share meals. Small frequent portions keep blood sugar steady.' },
    ],
    never: [
      'Do not eat mushrooms or wild plants you cannot positively identify.',
      'Do not use a charcoal or generator stove indoors. It kills silently.',
    ],
    keywords: ['food', 'eat', 'hungry', 'ration', 'spoiled', 'refrigerator', 'gas stove', 'supplies'],
    urgency: 2,
  },
  {
    id: 'shelter',
    title: 'Emergency shelter',
    domain: 'shelter',
    summary: 'Keep off the ground, out of the wind, and stay dry.',
    steps: [
      { text: 'Get off the bare ground: use mats, cardboard, boards or plastic sheeting.', critical: true },
      { text: 'Insulate below you, not just above. More layers under beats more on top.' },
      { text: 'Stop the wind before stopping the rain: block the prevailing side, then the roof.', critical: true },
      { text: 'Keep a 2 cm gap for ventilation if you burn anything.', critical: true },
      { text: 'Never shelter under a damaged tree, leaning wall or wall with cracks.', critical: true },
      { text: 'Keep your shoes on. Glass and nails are the most common injury in shelters.' },
    ],
    never: ['Do not shelter under an overpass or in a flooded underpass.', 'Do not use a stove or generator inside the shelter.'],
    keywords: ['shelter', 'tent', 'homeless', 'roof', 'blanket', 'cold night', 'tarp', 'sleep'],
    urgency: 2,
  },
  {
    id: 'fire',
    title: 'Fire and smoke',
    domain: 'hazard',
    summary: 'Stay low, wet cloth over the face, get out and stay out.',
    steps: [
      { text: 'Get out fast and stay out. Do not return for belongings.', critical: true },
      { text: 'Stay low under the smoke. Crawl if the air is black.', critical: true },
      { text: 'Cover nose and mouth with a damp cloth.' },
      { text: 'Feel doors with the back of your hand before opening. Warm means hot air behind.' },
      { text: 'If your clothes catch fire: stop, drop, cover your face and roll.' },
      { text: 'Close every door behind you to slow the fire.' },
    ],
    never: ['Do not use lifts.', 'Do not reopen a door that feels hot.'],
    keywords: ['fire', 'smoke', 'flames', 'evacuate', 'burning building', 'extinguish', 'gas leak'],
    urgency: 3,
  },
  {
    id: 'sanitation',
    title: 'Staying clean and disease-free',
    domain: 'hazard',
    summary: 'After a disaster, disease spreads through hands and water, not the air.',
    steps: [
      { text: 'Wash hands with soap after the toilet and before food. If no water, use ash.', critical: true },
      { text: 'Bury human waste at least 30 m from any water source, at least 1 m deep.' },
      { text: 'Boil or disinfect all drinking water, even if it looks clear.', critical: true },
      { text: 'Keep drinking water in clean closed containers, separate from washing water.' },
      { text: 'Any fever with diarrhea in the first days is dangerous. Get to a medical post.', critical: true },
      { text: 'Cover your mouth and nose when near anyone coughing.' },
    ],
    never: ['Do not defecate near a water source or upstream of it.', 'Do not share cups for drinking.'],
    keywords: ['sanitation', 'toilet', 'wash', 'soap', 'diarrhea', 'disease', 'hygiene', 'contagious', 'fever'],
    urgency: 2,
  },
  {
    id: 'earthquake',
    title: 'Earthquake',
    domain: 'hazard',
    summary: 'Drop, cover, hold on. Then move out and expect aftershocks.',
    steps: [
      { text: 'Drop to hands and knees and get under sturdy furniture or against an inside wall.', critical: true },
      { text: 'Cover your head and neck with your arms.', critical: true },
      { text: 'Hold on until the shaking stops.', critical: true },
      { text: 'Once shaking stops, leave by the stairs, not the lift. Expect aftershocks.' },
      { text: 'Do not stand in a doorway and do not run outside while shaking.' },
      { text: 'Check for gas smell. If present, turn it off if you can and get everyone out.', critical: true },
    ],
    never: ['Do not re-enter a building with fresh cracks, tilting or smells of gas.', 'Do not light a flame if you suspect a leak.'],
    keywords: ['earthquake', 'shaking', 'tremor', 'aftershock', 'collapsed building', 'rubble'],
    urgency: 3,
  },
  {
    id: 'flood',
    title: 'Flood',
    domain: 'hazard',
    summary: 'Go to high ground. Never walk or drive through moving water.',
    steps: [
      { text: 'Move to higher ground immediately. Take water, phone, power bank and documents.', critical: true },
      { text: 'Never walk or drive through moving water. 30 cm can sweep a car away.', critical: true },
      { text: 'Avoid power lines, and anything electrical that has been submerged.', critical: true },
      { text: 'Treat all floodwater as contaminated. Do not let children play in it.' },
      { text: 'If trapped above water, signal at the roof with cloth and light, do not go into the current.' },
      { text: 'After the flood, wash every wound and get tetanus advice if possible.' },
    ],
    never: ['Do not drink floodwater.', 'Do not touch downed wires or turn power back on in a flooded building.'],
    keywords: ['flood', 'flooding', 'water rising', 'drown', 'current', 'river', 'rain', 'storm surge', 'mud'],
    urgency: 3,
  },
  {
    id: 'cyclone',
    title: 'Cyclone, hurricane or high wind',
    domain: 'hazard',
    summary: 'Shelter in a solid inner room. Stay away from glass.',
    steps: [
      { text: 'Stay indoors in the strongest room, an inner room without windows.', critical: true },
      { text: 'Close and lock doors and windows. Move away from glass.', critical: true },
      { text: 'If the wind suddenly stops, you may be in the eye. Do not go outside.', critical: true },
      { text: 'Brace under a sturdy table if you have one. Wear shoes.' },
      { text: 'Have water, torch, radio and documents within arm reach.' },
    ],
    never: ['Do not go outside during the calm of the eye.', 'Do not use a candle in a room with a broken window and gas.'],
    keywords: ['cyclone', 'hurricane', 'typhoon', 'storm', 'wind', 'typhoon', 'storm surge'],
    urgency: 3,
  },
  {
    id: 'wildfire',
    title: 'Wildfire',
    domain: 'hazard',
    summary: 'Leave early. If you cannot, take the lowest, most enclosed space.',
    steps: [
      { text: 'Leave early on the advised route. Do not wait until the fire is visible.', critical: true },
      { text: 'Take only essentials: water, phone, chargers, documents, medication.', critical: true },
      { text: 'If trapped: enter a vehicle, close vents, or go to a low, clear area.', critical: true },
      { text: 'Cover yourself in a natural-fibre garment or a foil blanket, but never synthetic fabric.' },
      { text: 'Lie flat, face down, and protect your airway.' },
    ],
    never: ['Do not outrun a fire uphill.', 'Do not wear synthetics to cover yourself.'],
    keywords: ['wildfire', 'bushfire', 'forest fire', 'smoke', 'ash', 'fire evacuation'],
    urgency: 3,
  },
  {
    id: 'panic',
    title: "Panic and acute stress",
    domain: 'mind',
    summary: 'Slow your breathing. This will pass.',
    steps: [
      { text: 'Say out loud: this is a normal reaction, my body is trying to protect me.', critical: true },
      { text: 'Breathe in for 4 counts, out for 6 counts. Do it for 2 minutes.', critical: true },
      { text: 'Name 5 things you can see, 4 you can touch, 3 you can hear.', critical: true },
      { text: 'Press your feet flat on the ground and feel the floor holding you.' },
      { text: 'Drink water slowly, if you have it.' },
      { text: 'If you are with a child, help them first. Your calm is contagious.' },
    ],
    never: [
      'This does not replace a doctor or counsellor. See the talk-about-it section, not a search box.',
      'Do not use alcohol to manage the panic.',
    ],
    keywords: [
      'panic', 'anxiety', 'attack', 'breathe', 'scared', 'fear', 'hyperventilate', 'calm', 'overwhelmed',
      'crying', 'mental health', 'stress', 'trauma', 'cant sleep', 'nightmares', 'grounding',
    ],
    urgency: 1,
  },
  {
    id: 'grief',
    title: 'Grief and loss',
    domain: 'mind',
    summary: 'Nothing is broken in you. Do the next small thing, and share the weight.',
    steps: [
      { text: 'Eat and drink something, even if you are not hungry.', critical: true },
      { text: 'Stay near another person. Avoid being alone for long in the first days.' },
      { text: 'Keep a routine: wake, wash, eat. Structure holds people when feelings cannot.' },
      { text: 'You do not need to explain anything to anyone. Say only what you want to say.' },
      { text: 'When you are ready, tell someone one true sentence about the person you lost.' },
    ],
    never: ['Children hide grief. Do not punish a child for bed-wetting or clinging in the first weeks.'],
    keywords: ['grief', 'loss', 'died', 'death', 'dead', 'mourning', 'bereaved', 'sad', 'alone'],
    urgency: 1,
  },
  {
    id: 'children',
    title: 'Helping children in a disaster',
    domain: 'mind',
    summary: 'Stay close, keep them warm, protect their routine.',
    steps: [
      { text: 'Keep them with a familiar adult at all times.', critical: true },
      { text: 'Answer their questions simply and honestly, even if the answer is "I do not know", but not about the danger you are in now. Be honest about the next hour only.' },
      { text: 'Give them a small job. It restores a sense of control.' },
      { text: 'Keep families together and write names on each child\'s arm or clothing.' },
      { text: 'Breastfeeding mothers should keep feeding. Water and food for children comes first.' },
    ],
    never: [
      'Do not say "be brave" or "don\'t cry".',
      'Do not let a child watch upsetting video repeatedly.',
    ],
    keywords: ['child', 'children', 'baby', 'kid', 'infant', 'school', 'parent', 'breastfeed'],
    urgency: 2,
  },
  {
    id: 'signal',
    title: 'Being found and sending a signal',
    domain: 'comms',
    summary: 'Light, cloth and repeated sound. Stay put if you are safe.',
    steps: [
      { text: 'If you are not in danger, stay where you are. People search along routes you already took.', critical: true },
      { text: 'Signal in threes: three whistle blasts, three flashes, three rocks. Three means "I need help".', critical: true },
      { text: 'Make anything visible from the air: bright cloth, large X, mirror flashes.' },
      { text: 'Use the phone SOS in this app: it broadcasts to any device within Bluetooth range and relays.', critical: true },
      { text: 'Keep the phone warm and in airplane mode with Bluetooth on, to stretch the battery for days.' },
      { text: 'Conserve: send an SOS every 20 minutes rather than continuously.' },
    ],
    never: [
      'Do not shout continuously. You will lose your voice, which is what rescuers listen for.',
      'Do not leave a clearly marked, safe location to search on your own.',
    ],
    keywords: ['signal', 'rescue', 'found', 'sos', 'whistle', 'missing', 'search', 'help me', 'lost', 'trapped'],
    urgency: 3,
  },
  {
    id: 'power',
    title: 'Making the phone battery last',
    domain: 'comms',
    summary: 'Airplane mode plus Bluetooth on. Dim, dark, and stop refreshing the screen.',
    steps: [
      { text: 'Turn on airplane mode, then switch Bluetooth back on. This kills the radio search, keeps the mesh.', critical: true },
      { text: 'Screen is the biggest drain: turn brightness to the lowest usable level.', critical: true },
      { text: 'Charge in short bursts when you find power. Do not leave a phone on a charger unattended.' },
      { text: 'Close everything else. Send one message and put the phone away.' },
      { text: 'Cold drains batteries: keep the phone in an inside pocket, never on the ground.' },
      { text: 'If the battery is critical, decide now: preserve it for SOS only.' },
    ],
    never: ['Do not charge a wet or damaged battery. Discard if it swells, smells or gets hot.'],
    keywords: ['battery', 'power', 'charge', 'drain', 'airplane mode', 'power bank', 'dead phone'],
    urgency: 2,
  },
  {
    id: 'grounding',
    title: 'Grounding when panic rises',
    domain: 'mind',
    summary: 'Name what is around you until the wave passes. You do not have to fix everything now.',
    steps: [
      { text: 'Sit down if you can. Put both feet on the floor and feel the ground.', critical: true },
      { text: 'Name five things you can see, four you can touch, three you can hear, two you can smell, one you can taste.' },
      { text: 'Breathe out longer than you breathe in. In for four, out for six.', critical: true },
      { text: 'Hold something cold, or splash cool water on your face if it is safe.' },
      { text: 'Say where you are and what is happening out loud: "I am in the school hall. The shaking is passing."' },
      { text: 'Stay with one person if you can. Panic is easier with company.' },
    ],
    never: [
      'Do not drive or operate machinery while you are panicking.',
      'Do not use alcohol or unprescribed medicine to calm down.',
    ],
    keywords: ['panic', 'anxiety', 'grounding', 'shaking', 'breathing', 'fear', 'scared', 'overwhelmed', 'calm'],
    urgency: 2,
  },
  {
    id: 'sleep',
    title: 'Sleeping after a disaster',
    domain: 'mind',
    summary: 'Rest still counts. Keep the body warm, the light low, and the night predictable.',
    steps: [
      { text: 'Keep a simple routine: same wash, same place, same short wind-down.', critical: true },
      { text: 'Dim the screen and stop scrolling 30 minutes before you lie down.' },
      { text: 'Keep warm and dry. Cold is a bigger sleep thief than noise.' },
      { text: 'If sleep will not come, rest with your eyes closed. Do not fight the clock.' },
      { text: 'Write down one thing for tomorrow so your mind can put it down.' },
      { text: 'Tell one person you are trying to sleep, so they do not wake you unnecessarily.' },
    ],
    never: [
      'Do not use alcohol or unprescribed medicine to sleep.',
      "Do not take someone else's sleeping tablets.",
    ],
    keywords: ['sleep', 'insomnia', 'awake', 'night', 'rest', 'tired', 'nightmare', "can't sleep"],
    urgency: 1,
  },
  {
    id: 'anger',
    title: 'Anger after loss',
    domain: 'mind',
    summary: 'Anger is a normal alarm. Move it out of your body before you make a decision.',
    steps: [
      { text: 'Step away from the person or thing you are angry at. Put distance between you.', critical: true },
      { text: 'Breathe out slowly and unclench your hands and jaw.', critical: true },
      { text: 'Move: walk, carry water, stack supplies. Burn the energy somewhere safe.' },
      { text: 'Name it plainly: "I am angry because this is unfair." Naming it lowers the heat.' },
      { text: 'Do not make a permanent decision while the anger is at its peak. Wait 20 minutes.' },
      { text: 'Tell one person how you feel, even if the answer is "I do not know what to do."' },
    ],
    never: [
      'Do not hit, shove, or threaten anyone, even if they are provoking you.',
      'Do not handle a weapon or drive while you are this angry.',
    ],
    keywords: ['anger', 'angry', 'rage', 'furious', 'fight', 'irritated', 'unfair', 'temper'],
    urgency: 2,
  },
  {
    id: 'loneliness',
    title: 'When you feel alone',
    domain: 'mind',
    summary: 'Find one person, one task, and one small point of contact. Connection is a survival supply.',
    steps: [
      { text: 'Find one person to be near, even if you do not talk. Presence helps.', critical: true },
      { text: 'Send one short message on the mesh: "I am here. Are you okay?"' },
      { text: 'Do one small useful task: fill water, check a neighbour, tidy your space.' },
      { text: 'Say the truth to someone: "I do not want to be alone right now."' },
      { text: 'If you have no one nearby, write down three people you will look for tomorrow.' },
      { text: 'Keep the phone charged and the mesh screen open so someone can reach you.' },
    ],
    never: [
      'Do not assume silence means nobody cares. Radios and people are exhausted.',
      'Do not withdraw from everyone for a whole day without telling one person.',
    ],
    keywords: ['alone', 'lonely', 'isolated', 'no one', 'abandoned', 'connection', 'friend', 'company'],
    urgency: 2,
  },
] as const;

export const KNOWLEDGE_BY_ID: ReadonlyMap<TopicId, KnowledgeEntry> = new Map(
  KNOWLEDGE_BASE.map((entry) => [entry.id, entry]),
);

export const DOMAIN_LABELS: Record<KnowledgeEntry['domain'], string> = {
  medical: 'First aid',
  'water-food': 'Water and food',
  shelter: 'Shelter',
  hazard: 'Hazards',
  mind: 'Mind',
  comms: 'Comms and power',
};
