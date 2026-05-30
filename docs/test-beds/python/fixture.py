"""Python test bed."""
from helper import Helper

class Box:
    value: object

class Container:
    items: list
    def add(self, item: Box) -> None:
        self.items.append(item)
    def size(self) -> int:
        return len(self.items)

def process(input: Box) -> Container:
    c = Container()
    c.add(input)
    Helper.log(c)
    return c

FOO: int = 42
