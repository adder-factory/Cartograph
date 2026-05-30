# Elixir test bed — a module with functions and an internal call.
defmodule Greeter do
  @greeting "hello"

  def greet(name) do
    "#{@greeting} #{name}"
  end

  def main do
    greet("world")
  end
end
