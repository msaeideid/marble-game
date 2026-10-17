from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Vec3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def copy(self) -> Vec3:
        return Vec3(self.x, self.y, self.z)

    def to_list(self) -> list[float]:
        return [self.x, self.y, self.z]

    @staticmethod
    def from_list(v: list[float]) -> Vec3:
        return Vec3(float(v[0]), float(v[1]), float(v[2]))
