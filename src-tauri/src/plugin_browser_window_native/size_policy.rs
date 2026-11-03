//! Size and constraint conversions shared by the native BrowserWindow adapter
//! and its runtime geometry actions.

/// The coordinate space in which constructor or runtime size constraints were
/// supplied. Electron exposes getters in outer-window coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ConstraintBasis {
    #[default]
    Outer,
    Content,
}

/// Adapter-owned raw constraint values. `None` and zero both mean unbounded;
/// the basis records how nonzero values were originally expressed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct NativeConstraints {
    pub(crate) min_width: Option<f64>,
    pub(crate) min_height: Option<f64>,
    pub(crate) max_width: Option<f64>,
    pub(crate) max_height: Option<f64>,
    pub(crate) basis: ConstraintBasis,
}

impl NativeConstraints {
    /// Return the stored minimum pair in its declared basis. Zero is the
    /// compatibility sentinel for an unbounded axis.
    pub(crate) fn minimum(self) -> [f64; 2] {
        [
            self.min_width.unwrap_or(0.0),
            self.min_height.unwrap_or(0.0),
        ]
    }

    /// Return the stored maximum pair in its declared basis. Zero is the
    /// compatibility sentinel for an unbounded axis.
    pub(crate) fn maximum(self) -> [f64; 2] {
        [
            self.max_width.unwrap_or(0.0),
            self.max_height.unwrap_or(0.0),
        ]
    }

    pub(crate) fn validate(self) -> Result<(), String> {
        for (name, value) in [
            ("minimum width", self.min_width),
            ("minimum height", self.min_height),
            ("maximum width", self.max_width),
            ("maximum height", self.max_height),
        ] {
            if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
                return Err(invalid(format!("{name} must be finite and nonnegative")));
            }
        }
        if self
            .min_width
            .zip(self.max_width)
            .is_some_and(|(min, max)| min > 0.0 && max > 0.0 && min > max)
            || self
                .min_height
                .zip(self.max_height)
                .is_some_and(|(min, max)| min > 0.0 && max > 0.0 && min > max)
        {
            return Err(invalid("minimum size cannot exceed maximum size"));
        }
        Ok(())
    }

    fn unbounded_zeros(mut self) -> Self {
        self.min_width = nonzero(self.min_width);
        self.min_height = nonzero(self.min_height);
        self.max_width = nonzero(self.max_width);
        self.max_height = nonzero(self.max_height);
        self
    }
}

/// A single UI-thread measurement of the physical outer and content sizes.
/// The measured chrome delta is retained in logical units for all conversions
/// within that geometry operation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FrameMetrics {
    scale: f64,
    chrome: [f64; 2],
}

impl FrameMetrics {
    pub(crate) fn new(scale: f64, outer: [u32; 2], inner: [u32; 2]) -> Result<Self, String> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(native_geometry("scale factor must be finite and positive"));
        }
        if outer[0] < inner[0] || outer[1] < inner[1] {
            return Err(native_geometry(
                "outer size cannot be smaller than content size",
            ));
        }
        let chrome = [
            f64::from(outer[0] - inner[0]) / scale,
            f64::from(outer[1] - inner[1]) / scale,
        ];
        if chrome
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(native_geometry("measured frame delta is invalid"));
        }
        Ok(Self { scale, chrome })
    }

    /// Translate an Electron outer-size request into Tauri's inner-size unit.
    /// Physical chrome is measured per operation; no platform constants are
    /// assumed. The result must still represent at least one physical pixel.
    pub(crate) fn content_size_for_outer(self, outer: [f64; 2]) -> Result<[f64; 2], String> {
        let content = [outer[0] - self.chrome[0], outer[1] - self.chrome[1]];
        if content
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(unsupported(
                "requested outer size is smaller than measured window chrome",
            ));
        }
        self.validate_content_size(content)
    }

    /// Validate a logical content size against the physical dimensions that
    /// Tauri will eventually give the platform windowing API. This is shared
    /// by outer-size conversion, direct content setters, and initial content
    /// sizing so none silently rounds a positive request to zero pixels.
    pub(crate) fn validate_content_size(self, content: [f64; 2]) -> Result<[f64; 2], String> {
        validate_physical_dimension(content[0], self.scale, "width")?;
        validate_physical_dimension(content[1], self.scale, "height")?;
        Ok(content)
    }

    /// Convert a stored constraint into the public Electron outer basis.
    /// Calling this on an already-outer value is a no-op apart from zero
    /// normalization, so callers never accumulate round-trip conversions.
    pub(crate) fn outer_constraints(
        self,
        value: NativeConstraints,
    ) -> Result<NativeConstraints, String> {
        value.validate()?;
        let mut outer = value.unbounded_zeros();
        if value.basis == ConstraintBasis::Content {
            outer.min_width = add_chrome(value.min_width, self.chrome[0])?;
            outer.min_height = add_chrome(value.min_height, self.chrome[1])?;
            outer.max_width = add_chrome(value.max_width, self.chrome[0])?;
            outer.max_height = add_chrome(value.max_height, self.chrome[1])?;
        }
        outer.basis = ConstraintBasis::Outer;
        outer.validate()?;
        Ok(outer)
    }

    /// Convert public outer constraints into Tauri's content/inner basis.
    /// Unbounded axes stay unbounded; minimums may reach zero after removing
    /// chrome, while a maximum that cannot contain the chrome is impossible.
    pub(crate) fn inner_constraints(
        self,
        value: NativeConstraints,
    ) -> Result<NativeConstraints, String> {
        value.validate()?;
        let mut inner = value.unbounded_zeros();
        if value.basis == ConstraintBasis::Outer {
            inner.min_width = subtract_chrome(value.min_width, self.chrome[0], false)?;
            inner.min_height = subtract_chrome(value.min_height, self.chrome[1], false)?;
            inner.max_width = subtract_chrome(value.max_width, self.chrome[0], true)?;
            inner.max_height = subtract_chrome(value.max_height, self.chrome[1], true)?;
        }
        inner.basis = ConstraintBasis::Content;
        if let Some(max_width) = nonzero(inner.max_width) {
            validate_physical_dimension(max_width, self.scale, "maximum width")?;
        }
        if let Some(max_height) = nonzero(inner.max_height) {
            validate_physical_dimension(max_height, self.scale, "maximum height")?;
        }
        inner.validate()?;
        Ok(inner)
    }
}

fn nonzero(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value > 0.0)
}

fn validate_physical_dimension(value: f64, scale: f64, name: &str) -> Result<(), String> {
    if !value.is_finite() || value <= 0.0 {
        return Err(invalid(format!("{name} must be finite and positive")));
    }
    let physical = value * scale;
    if !physical.is_finite() || physical.round() < 1.0 || physical.round() > f64::from(u32::MAX) {
        return Err(invalid(format!(
            "{name} cannot be represented in physical pixels"
        )));
    }
    Ok(())
}

fn add_chrome(value: Option<f64>, chrome: f64) -> Result<Option<f64>, String> {
    value
        .filter(|value| *value > 0.0)
        .map(|value| {
            let converted = value + chrome;
            if converted.is_finite() {
                Ok(converted)
            } else {
                Err(invalid("converted outer constraint overflowed"))
            }
        })
        .transpose()
}

fn subtract_chrome(value: Option<f64>, chrome: f64, maximum: bool) -> Result<Option<f64>, String> {
    let Some(value) = value.filter(|value| *value > 0.0) else {
        return Ok(None);
    };
    let converted = value - chrome;
    if !converted.is_finite() {
        return Err(invalid("converted content constraint is not finite"));
    }
    if maximum && converted <= 0.0 {
        return Err(unsupported(
            "maximum outer constraint cannot contain measured window chrome",
        ));
    }
    Ok(Some(converted.max(0.0)))
}

fn invalid(message: impl AsRef<str>) -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS: {}",
        message.as_ref()
    )
}

fn native_geometry(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_GEOMETRY: {}", message.as_ref())
}

fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}
