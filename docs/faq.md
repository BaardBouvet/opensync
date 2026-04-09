# Frequently Asked Questions

## Identity & Clusters

### What happens when two clusters are merged?

A *cluster* is a group of records across connected systems that the engine has
determined represent the same real-world entity. Each cluster has a single
**canonical ID** in the shadow state.

When two clusters are merged — because a new identity link is discovered that
bridges them — the engine reassigns everything from the losing canonical to the
winning canonical:

- All identity-map entries (external IDs from every connector) are repointed to
  the winning canonical ID.
- All shadow-state rows are repointed to the winning canonical ID.
- The losing canonical ID ceases to exist.

From that point on, every connector in the channel sees a unified view: reads
and writes are coordinated under the single merged canonical, and the next sync
cycle propagates any missing fields in either direction.

Merges are irreversible without a full rollback. If an incorrect merge occurs
(e.g. two distinct real-world entities were matched by mistake), the only
supported remedy is to roll back to the snapshot taken before the offending
sync run.
