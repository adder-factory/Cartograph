"""Fixture for the Pydantic schema-recognizer test — NOT a test file.

Consumed by ``__tests__/schema-recognizers-pydantic.test.ts``.

A realistic Pydantic module that exercises the recognizer end to end:
a ``BaseModel`` and a ``BaseSettings`` model, a ``Literal`` enum field,
optional + defaulted fields, and a model-typed field.
"""
from pydantic import BaseModel, BaseSettings
from typing import Literal, Optional


class Address(BaseModel):
    street: str
    city: str
    zip_code: Optional[str] = None


class User(BaseModel):
    name: str
    age: int = 0
    role: Literal["admin", "editor", "viewer"]
    home: Address


class AppSettings(BaseSettings):
    debug: bool = False
    region: Literal["us", "eu"]
