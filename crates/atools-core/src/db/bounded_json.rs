//! Bounded JSON serialization helpers shared by fixed-size database domains.

use std::io::{self, Write};

use serde::Serialize;

/// Counts serialized UTF-8 JSON bytes and stops as soon as `maximum` is exceeded.
///
/// Returns `None` for a budget overflow or a serialization error. The counter
/// never stores the emitted JSON bytes.
pub fn serialized_size<T: Serialize + ?Sized>(value: &T, maximum: usize) -> Option<usize> {
    struct Counter {
        bytes: usize,
        maximum: usize,
    }

    impl Write for Counter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if buffer.len() > self.maximum.saturating_sub(self.bytes) {
                return Err(io::Error::other("JSON byte budget exceeded"));
            }
            self.bytes += buffer.len();
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut counter = Counter { bytes: 0, maximum };
    serde_json::to_writer(&mut counter, value)
        .ok()
        .map(|()| counter.bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use serde::ser::{SerializeMap, SerializeSeq};
    use serde::{Serialize, Serializer};

    use super::serialized_size;

    const METADATA_ITEMS: usize = 100_000;

    struct RepeatedMetadata {
        serialized_items: Arc<AtomicUsize>,
    }

    impl Serialize for RepeatedMetadata {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            let mut sequence = serializer.serialize_seq(Some(METADATA_ITEMS))?;
            for _ in 0..METADATA_ITEMS {
                self.serialized_items.fetch_add(1, Ordering::Relaxed);
                sequence.serialize_element(&"metadata-value")?;
            }
            sequence.end()
        }
    }

    struct PinWithLargeMetadata {
        serialized_items: Arc<AtomicUsize>,
    }

    impl Serialize for PinWithLargeMetadata {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            let mut object = serializer.serialize_map(Some(4))?;
            object.serialize_entry("path", "/plugin")?;
            object.serialize_entry("name", "command")?;
            object.serialize_entry("type", "plugin")?;
            object.serialize_entry(
                "metadata",
                &RepeatedMetadata {
                    serialized_items: Arc::clone(&self.serialized_items),
                },
            )?;
            object.end()
        }
    }

    #[test]
    fn counter_stops_serializing_large_extra_metadata_after_budget_overflow() {
        let serialized_items = Arc::new(AtomicUsize::new(0));
        let value = PinWithLargeMetadata {
            serialized_items: Arc::clone(&serialized_items),
        };

        assert_eq!(serialized_size(&value, 128 * 1024), None);
        let yielded = serialized_items.load(Ordering::Relaxed);
        assert!(yielded > 0);
        assert!(yielded < METADATA_ITEMS);
    }
}
