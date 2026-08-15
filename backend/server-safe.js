'use strict';

// Freeze weekly recommendations before the normal safety layer registers the
// recommendation endpoint. The safety/cost layer still owns all auth guards,
// caches and optimized catalogue reads.
require('./recommendationSnapshotsPreload');
require('./farreoSafetyPreload');
require('./server');
