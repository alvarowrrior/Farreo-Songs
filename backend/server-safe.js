'use strict';

// Freeze daily/weekly recommendations before the normal safety layer registers
// the recommendation endpoint. The safety/cost layer still owns auth guards,
// optimized catalogue reads and the rest of the API protections.
require('./recommendationSnapshotsPreload');
require('./farreoSafetyPreload');
require('./server');
