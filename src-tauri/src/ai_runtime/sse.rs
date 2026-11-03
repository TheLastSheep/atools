use atools_core::ai_service::{AiErrorCode, AiServiceError};

pub const MAX_SSE_EVENT_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct SseDecoder {
    line: Vec<u8>,
    event_data: Vec<u8>,
    after_cr: bool,
}

impl SseDecoder {
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<String>, AiServiceError> {
        let mut events = Vec::new();
        for byte in input.iter().copied() {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.finish_line(&mut events)?;
                    self.after_cr = true;
                }
                b'\n' => self.finish_line(&mut events)?,
                _ => {
                    if self.line.len() >= MAX_SSE_EVENT_BYTES {
                        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
                    }
                    self.line.push(byte);
                }
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, AiServiceError> {
        let mut events = Vec::new();
        if !self.line.is_empty() {
            self.finish_line(&mut events)?;
        }
        self.dispatch(&mut events)?;
        Ok(events)
    }

    fn finish_line(&mut self, events: &mut Vec<String>) -> Result<(), AiServiceError> {
        let line = std::str::from_utf8(&self.line)
            .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
        if line.is_empty() {
            return self.dispatch(events);
        }
        if line.starts_with(':') {
            self.line.clear();
            return Ok(());
        }
        if let Some((field, raw_value)) = line.split_once(':') {
            if field == "data" {
                if !self.event_data.is_empty() {
                    self.event_data.push(b'\n');
                }
                let value = raw_value.strip_prefix(' ').unwrap_or(raw_value);
                self.event_data.extend_from_slice(value.as_bytes());
                if self.event_data.len() > MAX_SSE_EVENT_BYTES {
                    return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
                }
            }
        }
        self.line.clear();
        Ok(())
    }

    fn dispatch(&mut self, events: &mut Vec<String>) -> Result<(), AiServiceError> {
        if self.event_data.is_empty() {
            return Ok(());
        }
        let data = std::str::from_utf8(&self.event_data)
            .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
        events.push(data.to_string());
        self.event_data.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_utf8_crlf_and_multiline_data_decode_in_order() {
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(b": keepalive\r\nevent: message\r\ndata: {\"x\":\"caf\xc3")
            .unwrap()
            .is_empty());
        let events = decoder.push(b"\xa9\"}\r\ndata: second\r\n\r\n").unwrap();
        assert_eq!(events, vec!["{\"x\":\"café\"}\nsecond"]);
    }

    #[test]
    fn malformed_utf8_and_unbounded_line_or_event_fail_closed() {
        let mut malformed = SseDecoder::default();
        assert_eq!(
            malformed.push(b"data: \xff\n\n").unwrap_err().code,
            AiErrorCode::MalformedResponse
        );
        let mut long_line = SseDecoder::default();
        assert_eq!(
            long_line
                .push(&vec![b'x'; MAX_SSE_EVENT_BYTES + 1])
                .unwrap_err()
                .code,
            AiErrorCode::PayloadTooLarge
        );
        let mut long_event = SseDecoder::default();
        let oversized = [b"data: ".as_slice(), &vec![b'x'; MAX_SSE_EVENT_BYTES]].concat();
        assert_eq!(
            long_event.push(&oversized).unwrap_err().code,
            AiErrorCode::PayloadTooLarge
        );
    }
}
