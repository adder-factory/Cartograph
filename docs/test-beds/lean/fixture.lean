import Mathlib.Data.Nat.Basic

structure User where
  name : String

inductive Role where
  | admin
  | user

def greet (u : User) : String := u.name
theorem id_eq (n : Nat) : n = n := rfl
abbrev UserName := String
