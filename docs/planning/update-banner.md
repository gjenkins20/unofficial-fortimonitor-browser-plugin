# Update-Available Banner (FMN-157)

The toolkit's background service worker fetches the latest `manifest.json` from `github.com/gjenkins20/unofficial-fortimonitor-browser-plugin` at most once per hour, semver-compares the remote version against `chrome.runtime.getManifest().version`, and stores the result. The popup renders a banner above the tool grid when a newer version is published.

Nothing auto-updates. The banner explicitly instructs the operator to run `git pull` in the cloned repo and reload the extension. The two action buttons snooze the banner for 7 days or dismiss it for 24 hours.

The check can be disabled entirely via popup -> Settings ("Check the GitHub repo for newer versions"). On by default.

See also: [FMN-157 ticket on Plane](https://app.plane.so/myrug/projects/).
