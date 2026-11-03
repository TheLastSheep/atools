#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionPhase {
    Opening,
    Open,
    Closing,
}

impl SessionPhase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Open => "open",
            Self::Closing => "closing",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SessionSignal {
    pub(crate) phase: SessionPhase,
    pub(crate) opened: bool,
    pub(crate) ready: bool,
    pub(crate) out_acknowledged: bool,
}
