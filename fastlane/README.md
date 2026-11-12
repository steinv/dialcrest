fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android validate

```sh
[bundle exec] fastlane android validate
```

Check that the Play service-account key works

### android status

```sh
[bundle exec] fastlane android status
```

Show the version codes and release names on every track

### android build

```sh
[bundle exec] fastlane android build
```

Build a release AAB with the next version code

### android internal

```sh
[bundle exec] fastlane android internal
```

Build and upload to the internal testing track

Options: notes:"…" (en-US release notes)

### android upload

```sh
[bundle exec] fastlane android upload
```

Upload an already-built AAB to a track. Options: track:internal notes:"…"

### android promote

```sh
[bundle exec] fastlane android promote
```

Promote the latest release of one track to another

Options: from:internal to:production rollout:0.2 (fraction; 1 = everyone)

### android rollout

```sh
[bundle exec] fastlane android rollout
```

Change the staged-rollout fraction of the latest release on a track

Options: rollout:0.5 track:production (rollout:1 completes the rollout)

### android halt

```sh
[bundle exec] fastlane android halt
```

Halt the staged rollout of the latest release on a track (default production)

### android metadata_download

```sh
[bundle exec] fastlane android metadata_download
```

Download the current store listing into fastlane/metadata/android

### android metadata_upload

```sh
[bundle exec] fastlane android metadata_upload
```

Upload the store listing (texts + images) from fastlane/metadata/android

----


## iOS

### ios status

```sh
[bundle exec] fastlane ios status
```

Show the latest TestFlight build number

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Build a signed IPA and upload it to TestFlight. Options: notes:"…"

### ios release

```sh
[bundle exec] fastlane ios release
```

Submit the latest TestFlight build of the pubspec version for App Store review

Options: phased:true (7-day phased release), auto_release:true

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
