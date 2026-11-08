// What a map preview needs from the app, so a drawing of the map outside the app is the app's
// own decisions and not a re-statement of them: where the camera sits, how the sites group, and
// which names get written. Bundled into one global by map_preview.mjs.
export { fitView, placeLabels, projY, frameFill, FIT_MARGIN, labelFits } from "../../app/ui/app/model/camera";
export { clusterPoints, worstOf, CELL, bubbleRadius } from "../../app/ui/app/model/mapClusters";
export { buildExampleNetwork } from "../../app/ui/app/data/exampleNetwork";
export { shortSiteName } from "../../app/ui/app/model/site";
export { allSites } from "../../app/ui/app/model/site";
export { ensurePlaces, regionOf } from "../../app/ui/app/data/places";

export { askedAbout, crossingDepth } from "../../app/ui/app/model/camera";
