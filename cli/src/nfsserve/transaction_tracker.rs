use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// `TransactionTracker` tracks the state of transactions to detect retransmissions.
///
/// Transactions are keyed on `(xid, verifier)` where `verifier` is a stable per-client
/// identity (the RPC credential/verifier bytes) rather than the ephemeral client socket
/// address. This keeps writes idempotent: a client that reconnects from a new source port
/// and replays an unacknowledged request is still recognized as a retransmission instead
/// of producing a duplicate version (G3).
pub struct TransactionTracker {
    retention_period: Duration,
    transactions: Mutex<HashMap<TransactionKey, TransactionState>>,
}

/// Stable identity of a single RPC: the transaction id plus the client verifier bytes.
type TransactionKey = (u32, Vec<u8>);

impl TransactionTracker {
    pub fn new(retention_period: Duration) -> Self {
        Self {
            retention_period,
            transactions: Mutex::new(HashMap::new()),
        }
    }

    /// Checks if the transaction is a retransmission.
    /// If it's a new transaction, it is marked as `InProgress`.
    ///
    /// Returns `true` if the transaction is a retransmission, `false` otherwise.
    pub fn is_retransmission(&self, xid: u32, verifier: &[u8]) -> bool {
        let key = (xid, verifier.to_vec());
        let mut transactions = self
            .transactions
            .lock()
            .expect("unable to unlock transactions mutex");
        housekeeping(&mut transactions, self.retention_period);
        if let std::collections::hash_map::Entry::Vacant(e) = transactions.entry(key) {
            e.insert(TransactionState::InProgress);
            false
        } else {
            true
        }
    }

    /// Marks the transaction as processed.
    pub fn mark_processed(&self, xid: u32, verifier: &[u8]) {
        let key = (xid, verifier.to_vec());
        let completion_time = SystemTime::now();
        let mut transactions = self
            .transactions
            .lock()
            .expect("unable to unlock transactions mutex");
        if let Some(tx) = transactions.get_mut(&key) {
            *tx = TransactionState::Completed(completion_time);
        }
    }
}

fn housekeeping(transactions: &mut HashMap<TransactionKey, TransactionState>, max_age: Duration) {
    let mut cutoff = SystemTime::now() - max_age;
    transactions.retain(|_, v| match v {
        TransactionState::InProgress => true,
        TransactionState::Completed(completion_time) => completion_time >= &mut cutoff,
    });
}

pub enum TransactionState {
    InProgress,
    Completed(SystemTime),
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same (xid, verifier) replayed from a different socket is still a retransmission (G3).
    #[test]
    fn replay_with_same_verifier_is_retransmission() {
        let tracker = TransactionTracker::new(Duration::from_secs(60));
        let verifier = b"client-instance-a";

        assert!(!tracker.is_retransmission(7, verifier));
        tracker.mark_processed(7, verifier);
        // A reconnect changes the socket address but not the verifier; this must dedupe.
        assert!(tracker.is_retransmission(7, verifier));
    }

    // A different verifier with the same xid is a distinct transaction.
    #[test]
    fn same_xid_different_verifier_is_new() {
        let tracker = TransactionTracker::new(Duration::from_secs(60));

        assert!(!tracker.is_retransmission(7, b"client-a"));
        assert!(!tracker.is_retransmission(7, b"client-b"));
    }
}
