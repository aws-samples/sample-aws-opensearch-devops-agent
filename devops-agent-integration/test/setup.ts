import * as fc from "fast-check";

// Shared property-based-test configuration for the whole suite.
// Every fast-check property runs a minimum of 100 iterations by default.
fc.configureGlobal({ numRuns: 100 });
