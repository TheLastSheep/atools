use crate::plugin_browser_window_native::{
    size_policy::{ConstraintBasis, FrameMetrics, NativeConstraints},
    snapshot::{NativeBounds, NativeSnapshot},
};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Call {
    FrameMetrics,
    Constraints,
    SetInnerSize([f64; 2]),
    SetOuterPosition([f64; 2]),
    Center,
    SetInnerConstraints(NativeConstraints),
    RememberConstraints(NativeConstraints),
    Snapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    InnerSize,
    OuterPosition,
    Center,
    InnerConstraints,
    Snapshot,
}

pub(super) struct FakeBackend {
    pub(super) metrics: Result<FrameMetrics, String>,
    chrome: [f64; 2],
    pub(super) raw_constraints: NativeConstraints,
    pub(super) snapshot: NativeSnapshot,
    pub(super) calls: Vec<Call>,
    failure: Option<Failure>,
    pub(super) clamp_inner_size: Option<[f64; 2]>,
    pub(super) defer_inner_size: bool,
    pub(super) accepted_inner_constraints: Option<NativeConstraints>,
}

impl FakeBackend {
    pub(super) fn new(scale: f64, outer_px: [u32; 2], inner_px: [u32; 2]) -> Self {
        let metrics = FrameMetrics::new(scale, outer_px, inner_px);
        let chrome = [
            f64::from(outer_px[0].saturating_sub(inner_px[0])) / scale,
            f64::from(outer_px[1].saturating_sub(inner_px[1])) / scale,
        ];
        let snapshot = sample(
            [10.0, 20.0, 820.0, 620.0],
            [10.0, 20.0, 820.0 - chrome[0], 620.0 - chrome[1]],
        );
        Self {
            metrics,
            chrome,
            raw_constraints: NativeConstraints::default(),
            snapshot,
            calls: Vec::new(),
            failure: None,
            clamp_inner_size: None,
            defer_inner_size: false,
            accepted_inner_constraints: None,
        }
    }

    pub(super) fn fail(&mut self, failure: Failure) {
        self.failure = Some(failure);
    }

    pub(super) fn setters_ran(&self) -> bool {
        self.calls.iter().any(|call| {
            matches!(
                call,
                Call::SetInnerSize(_)
                    | Call::SetOuterPosition(_)
                    | Call::Center
                    | Call::SetInnerConstraints(_)
                    | Call::RememberConstraints(_)
            )
        })
    }
}

impl super::geometry_execution::GeometryBackend for FakeBackend {
    fn frame_metrics(&mut self) -> Result<FrameMetrics, String> {
        self.calls.push(Call::FrameMetrics);
        self.metrics.clone()
    }

    fn constraints(&mut self) -> NativeConstraints {
        self.calls.push(Call::Constraints);
        self.raw_constraints
    }

    fn set_inner_size(&mut self, size: [f64; 2]) -> Result<(), String> {
        self.calls.push(Call::SetInnerSize(size));
        if self.failure == Some(Failure::InnerSize) {
            return Err("fake inner size failure".into());
        }
        if !self.defer_inner_size {
            let actual = self.clamp_inner_size.unwrap_or(size);
            self.snapshot.content_bounds.width = actual[0];
            self.snapshot.content_bounds.height = actual[1];
            self.snapshot.bounds.width = actual[0] + self.chrome[0];
            self.snapshot.bounds.height = actual[1] + self.chrome[1];
        }
        Ok(())
    }

    fn set_outer_position(&mut self, position: [f64; 2]) -> Result<(), String> {
        self.calls.push(Call::SetOuterPosition(position));
        if self.failure == Some(Failure::OuterPosition) {
            return Err("fake outer position failure".into());
        }
        self.snapshot.bounds.x = position[0];
        self.snapshot.bounds.y = position[1];
        self.snapshot.content_bounds.x = position[0];
        self.snapshot.content_bounds.y = position[1];
        Ok(())
    }

    fn center(&mut self) -> Result<(), String> {
        self.calls.push(Call::Center);
        if self.failure == Some(Failure::Center) {
            return Err("fake center failure".into());
        }
        self.snapshot.bounds.x = 100.0;
        self.snapshot.bounds.y = 200.0;
        Ok(())
    }

    fn set_inner_constraints(&mut self, constraints: NativeConstraints) -> Result<(), String> {
        self.calls.push(Call::SetInnerConstraints(constraints));
        if self.failure == Some(Failure::InnerConstraints) {
            return Err("fake constraint write failure".into());
        }
        self.accepted_inner_constraints = Some(constraints);
        Ok(())
    }

    fn remember_constraints(&mut self, constraints: NativeConstraints) {
        self.calls.push(Call::RememberConstraints(constraints));
        self.raw_constraints = constraints;
        self.snapshot.minimum_size = constraints.minimum();
        self.snapshot.maximum_size = constraints.maximum();
    }

    fn snapshot(&mut self) -> Result<NativeSnapshot, String> {
        self.calls.push(Call::Snapshot);
        if self.failure == Some(Failure::Snapshot) {
            return Err("fake snapshot failure".into());
        }
        Ok(self.snapshot.clone())
    }
}

fn sample(bounds: [f64; 4], content: [f64; 4]) -> NativeSnapshot {
    NativeSnapshot {
        bounds: NativeBounds {
            x: bounds[0],
            y: bounds[1],
            width: bounds[2],
            height: bounds[3],
        },
        content_bounds: NativeBounds {
            x: content[0],
            y: content[1],
            width: content[2],
            height: content[3],
        },
        minimum_size: [0.0, 0.0],
        maximum_size: [0.0, 0.0],
        constraints_source: "adapter",
        visible: true,
        focused: false,
        always_on_top: false,
        minimized: false,
        maximized: false,
        full_screen: false,
        resizable: true,
        title: "test window".into(),
        native_sequence: 1,
    }
}
