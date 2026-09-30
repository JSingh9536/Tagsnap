# Assets

Two entries, and one of them is deliberately empty.

**`LaunchBackground`** is the same asphalt the whole app uses — `#0F1720`. The
launch screen is a plain fill rather than a splash image so the app opens
without a flash of white, which matters when it is opened in a dark cab at
5 a.m.

**`AppIcon`** has no image in it yet. Drop a single 1024×1024 PNG into it in
Xcode and every size is generated from that; iOS has not needed a folder of
per-density icons since iOS 14.

An empty AppIcon builds and runs fine for development and warns on archive. It
is left empty rather than filled with a placeholder because a placeholder that
looks deliberate is the kind of thing that ships.
