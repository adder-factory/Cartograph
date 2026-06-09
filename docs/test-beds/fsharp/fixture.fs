namespace Demo

module Math =
  open System

  let add x y = x + y

  type Person = { Name: string; Age: int }

  type Worker(name: string) =
    member _.Run value = add value 1

let result = Math.add 1 2
