//! Opaque, bounded icon URLs for members of the launcher app catalog.

mod image;
mod service;

pub(crate) use service::{icon_url, register};
