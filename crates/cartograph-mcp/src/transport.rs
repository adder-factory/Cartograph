use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};

use crate::{ServeError, protocol::JsonRpcResponse};

pub(crate) enum BoundedLine {
    Eof,
    Line(Vec<u8>),
    TooLarge,
}

pub(crate) async fn read_bounded_line<R>(
    reader: &mut R,
    maximum_bytes: usize,
) -> Result<BoundedLine, ServeError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(maximum_bytes.min(8_192));
    let mut overflowed = false;
    let mut saw_bytes = false;

    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| ServeError::InputReadFailed)?;
        if available.is_empty() {
            return Ok(finish_input(line, saw_bytes, overflowed));
        }

        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload_bytes = newline.unwrap_or(available.len());
        BoundedPayload {
            line: &mut line,
            overflowed: &mut overflowed,
            maximum_bytes,
        }
        .append(available, payload_bytes);

        let consumed = newline.map_or(available.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(finish_line(line, overflowed));
        }
    }
}

struct BoundedPayload<'a> {
    line: &'a mut Vec<u8>,
    overflowed: &'a mut bool,
    maximum_bytes: usize,
}

impl BoundedPayload<'_> {
    fn append(&mut self, available: &[u8], payload_bytes: usize) {
        if *self.overflowed {
            return;
        }
        let remaining = self.maximum_bytes.saturating_sub(self.line.len());
        if payload_bytes > remaining {
            *self.overflowed = true;
            return;
        }
        self.line.extend_from_slice(&available[..payload_bytes]);
    }
}

fn finish_input(line: Vec<u8>, saw_bytes: bool, overflowed: bool) -> BoundedLine {
    if saw_bytes {
        finish_line(line, overflowed)
    } else {
        BoundedLine::Eof
    }
}

fn finish_line(line: Vec<u8>, overflowed: bool) -> BoundedLine {
    if overflowed {
        BoundedLine::TooLarge
    } else {
        BoundedLine::Line(line)
    }
}

pub(crate) async fn write_responses<W>(
    mut output: W,
    mut responses: mpsc::Receiver<JsonRpcResponse>,
    maximum_bytes: usize,
) -> Result<(), ServeError>
where
    W: AsyncWrite + Unpin,
{
    while let Some(response) = responses.recv().await {
        let mut encoded = encode_bounded(response, maximum_bytes)?;
        encoded.push(b'\n');
        output
            .write_all(&encoded)
            .await
            .map_err(|_| ServeError::OutputWriteFailed)?;
    }
    output
        .flush()
        .await
        .map_err(|_| ServeError::OutputWriteFailed)
}

fn encode_bounded(response: JsonRpcResponse, maximum_bytes: usize) -> Result<Vec<u8>, ServeError> {
    let encoded = serde_json::to_vec(&response).map_err(|_| ServeError::OutputWriteFailed)?;
    if encoded.len() <= maximum_bytes {
        return Ok(encoded);
    }

    let fallback = response.output_too_large();
    let encoded = serde_json::to_vec(&fallback).map_err(|_| ServeError::OutputWriteFailed)?;
    if encoded.len() <= maximum_bytes {
        Ok(encoded)
    } else {
        Err(ServeError::OutputWriteFailed)
    }
}
