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
            return if !saw_bytes {
                Ok(BoundedLine::Eof)
            } else if overflowed {
                Ok(BoundedLine::TooLarge)
            } else {
                Ok(BoundedLine::Line(line))
            };
        }

        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload_bytes = newline.unwrap_or(available.len());
        if !overflowed {
            let remaining = maximum_bytes.saturating_sub(line.len());
            if payload_bytes <= remaining {
                line.extend_from_slice(&available[..payload_bytes]);
            } else {
                overflowed = true;
            }
        }

        let consumed = newline.map_or(available.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return if overflowed {
                Ok(BoundedLine::TooLarge)
            } else {
                Ok(BoundedLine::Line(line))
            };
        }
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
