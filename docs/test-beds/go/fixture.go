// Go test bed
package main

import "fmt"

type Box struct {
	Value string
}

type Container struct {
	Items []Box
}

func (c *Container) Add(item Box) {
	c.Items = append(c.Items, item)
}

func (c *Container) Size() int {
	return len(c.Items)
}

func Process(input Box) *Container {
	c := &Container{}
	c.Add(input)
	fmt.Println(c)
	return c
}

const FOO int = 42
