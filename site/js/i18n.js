/* ===========================================================================
   English glosses for the Spanish source values.

   THE RULE: THE ORIGINAL IS THE VALUE, THE ENGLISH IS AN ANNOTATION.
   -----------------------------------------------------------------
   Everything here is display-only. The stored value, the filter state, the URL
   and the CSV export all keep the publisher's exact string — so a link you send
   a colleague still resolves, and an exported file still matches the official
   data. The English appears in brackets after it:

       NO CONVENCIONAL (Unconventional)
       Bombeo Mecánico (Rod pump)
       VMUT (Vaca Muerta)

   That ordering is deliberate. Replacing the Spanish would quietly fork this
   site's vocabulary from the source everyone else cites, and anyone checking a
   figure against the publisher would have to translate back.

   WHAT IS NOT TRANSLATED, AND WHY
   -------------------------------
   Place names. Provinces (Neuquén, Chubut), fields, concessions and most basin
   names are toponyms; "translating" Cañadón Asfalto to "Asphalt Gully" would be
   noise dressed as help. Only where a basin name is an ordinary word — Noroeste,
   Austral — is a gloss given. Terms already in English in the source (SHALE,
   TIGHT, Plunger Lift, Jet Pump) are left alone.

   Where the industry has a standard English term, that is used rather than a
   literal rendering: Bombeo Mecánico is a rod pump, not "mechanical pumping";
   Electrosumergible is an ESP; pozo de avanzada is an appraisal well.
   =========================================================================== */

/** dimension -> { source value: English gloss }. Values absent here get none. */
const GLOSS = {
  cuenca: {
    'GOLFO SAN JORGE': 'San Jorge Gulf',
    'NEUQUINA': 'Neuquén',
    'CUYANA': 'Cuyo',
    'AUSTRAL': 'Austral / Magallanes',
    'NOROESTE': 'Northwest',
    'NORESTE': 'Northeast',
    // LOS BOLSONES, ÑIRIHUAU, CAÑADON ASFALTO, GENERAL LEVALLE: toponyms.
  },

  provincia: {
    'Estado Nacional': 'Federal jurisdiction',
    // all others are province names
  },

  tipo_recurso: {
    'CONVENCIONAL': 'Conventional',
    'NO CONVENCIONAL': 'Unconventional',
    'SIN RESERVORIO': 'No reservoir',
    'NO DISCRIMINADO': 'Not differentiated',
    'No informado': 'Not reported',
  },

  sub_tipo_recurso: {
    'No informado': 'Not reported',
    // SHALE and TIGHT are already English in the source
  },

  clasificacion: {
    'EXPLOTACION': 'Production',
    'EXPLORACION': 'Exploration',
    'SERVICIO': 'Service',
    'ALMACENAMIENTO': 'Storage',
    'No informado': 'Not reported',
  },

  subclasificacion: {
    'DESARROLLO': 'Development',
    'AVANZADA': 'Appraisal / step-out',
    'EXPLORACION': 'Exploration',
    'INYECTOR DE AGUA': 'Water injector',
    'EXTENSION': 'Extension',
    'EXPLORATORIO PROFUNDO': 'Deep exploratory',
    'INYECTOR TERCIARIA': 'Tertiary-recovery injector',
    'ESTUDIO': 'Study',
    'CONTROL': 'Observation',
    'SUMIDERO': 'Disposal',
    'PRODUCTOR DE AGUA': 'Water producer',
    'ALMACENAMIENTO DE GAS': 'Gas storage',
    'EXPLORATORIO SOMERO': 'Shallow exploratory',
    'INYECTOR DE GAS': 'Gas injector',
    'INYECTOR DE VAPOR': 'Steam injector',
    'No informado': 'Not reported',
  },

  well_fluid: {
    'Petrolífero': 'Oil',
    'Gasífero': 'Gas',
    'Inyección de Agua': 'Water injection',
    'Inyección de Gas': 'Gas injection',
    'Otro tipo': 'Other type',
    'Sumidero': 'Disposal',
    'Acuífero': 'Aquifer',
    'Monitoreo de almacenamiento': 'Storage monitoring',
    'Bidireccional de almacenamiento': 'Bidirectional storage',
    'No informado': 'Not reported',
  },

  well_state: {
    'Extracción Efectiva': 'Producing',
    'Abandonado': 'Abandoned',
    'En Estudio': 'Under study',
    'En Reserva para Recup. Sec./Asist.': 'Reserved for secondary / assisted recovery',
    'En Inyección Efectiva': 'Injecting',
    'Parado Transitoriamente': 'Temporarily shut in',
    'A Abandonar': 'To be abandoned',
    'En Espera de Reparación': 'Awaiting workover',
    'Abandono Temporario': 'Temporarily abandoned',
    'Otras Situación Inactivo': 'Other inactive status',
    'Parado Alta Relación Agua/Petróleo': 'Shut in — high water/oil ratio',
    'En Reserva de Gas': 'Gas reserve',
    'Otras Situación Activo': 'Other active status',
    'Parado Alta Relación Gas/Petróleo': 'Shut in — high gas/oil ratio',
    'En Reparación': 'Under workover',
    'Mantenimiento de Presión': 'Pressure maintenance',
  },

  lift_method: {
    'Sin Sistema de Extracción': 'No lift system',
    'Bombeo Mecánico': 'Rod pump',
    'Surgencia Natural': 'Natural flow',
    'Electrosumergible': 'ESP',
    'Cavidad Progresiva': 'PCP',
    'Bombeo Hidráulico': 'Hydraulic pump',
    'Otros Tipos de Extracción': 'Other lift types',
    // Pistoneo (Swabbing), Plunger Lift, Gas Lift, Jet Pump already carry English
  },

  completion_type: {
    'Tapón disparo': 'Plug and perf',
    'Punzado': 'Perforated',
    'Camisas deslizables': 'Sliding sleeves',
    'Camisas y punzados': 'Sleeves and perforations',
    'Jetteo': 'Jetting',
  },
};

/** Column aliases: the same vocabulary under a different column name. */
const ALIAS = {
  well_fluid_latest: 'well_fluid',
  well_state_latest: 'well_state',
  lift_method_latest: 'lift_method',
  formation_reported: 'formation',
  block_cuenca: 'cuenca',
  block_trajectory: 'trajectory',
  block_name_marker: 'name_marker',
};

/* Formation code -> spelled-out name, supplied by the build from the registry
   itself rather than hard-coded here: it is data, and it changes when the
   source does. */
let formationNames = {};
export function setFormationNames(map) { formationNames = map || {}; }

/** "vaca muerta" -> "Vaca Muerta", accents intact. */
function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-/(])([^\s\-/(])/g,
    (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Display string for one value of one dimension.
 * Returns the original untouched when there is nothing useful to add.
 */
export function label(dim, value) {
  if (value == null || value === '') return value;
  const key = ALIAS[dim] || dim;
  const raw = String(value);

  if (key === 'formation') {
    const name = formationNames[raw];
    // Skip the gloss when the code and the name say the same thing.
    if (name && name.toLowerCase() !== raw.toLowerCase()) {
      return `${raw} (${titleCase(name)})`;
    }
    return raw;
  }

  const gloss = GLOSS[key]?.[raw];
  return gloss ? `${raw} (${gloss})` : raw;
}

/** True when this dimension has any glosses at all — used to caption a column. */
export function hasGloss(dim) {
  const key = ALIAS[dim] || dim;
  return key === 'formation' || Boolean(GLOSS[key]);
}
