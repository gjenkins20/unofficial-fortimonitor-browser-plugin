# Search by Server ID (FMN-160)

A specialized matcher inside the FMN-152 omni-search bar that recognizes numeric tokens (e.g. `42024060`) and the `s-<id>` form used in FortiMonitor's checkbox values and instance URLs. Paste either into the search box and the omnibox jumps straight to the matching instance without requiring the operator to remember the server's display name.

Implemented in `extension/src/lib/sdwan-classifier.js` / `extension/src/content/augment.js`. Builds on the omni-search corpus rather than hitting a separate endpoint.

See also: [FMN-160 ticket on Plane](https://app.plane.so/myrug/projects/).
