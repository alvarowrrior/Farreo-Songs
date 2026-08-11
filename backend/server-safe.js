'use strict';

// Load the safety/cost layer before server.js imports Express/Multer.
require('./farreoSafetyPreload');
require('./server');
